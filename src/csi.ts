import Long from 'long'
import { unzip } from '@gmod/bgzf-filehandle'

import VirtualOffset, { fromBytes } from './virtualOffset'
import Chunk from './chunk'
import { longToNumber, optimizeChunks } from './util'

import IndexFile, { Options } from './indexFile'

const CSI1_MAGIC = 21582659 // CSI\1
const CSI2_MAGIC = 38359875 // CSI\2

function lshift(num: number, bits: number) {
  return num * 2 ** bits
}
function rshift(num: number, bits: number) {
  return Math.floor(num / 2 ** bits)
}

export default class CSI extends IndexFile {
  private maxBinNumber: number
  private depth: number
  private minShift: number
  constructor(args: any) {
    super(args)
    this.maxBinNumber = 0
    this.depth = 0
    this.minShift = 0
  }
  async lineCount(refName: string, opts: Options = {}): Promise<number> {
    const indexData = await this.parse(opts)
    if (!indexData) {
      return -1
    }
    const refId = indexData.refNameToId[refName]
    const idx = indexData.indices[refId]
    if (!idx) {
      return -1
    }
    const { stats } = indexData.indices[refId]
    if (stats) {
      return stats.lineCount
    }
    return -1
  }
  async indexCov() {
    throw new Error('CSI indexes do not support indexcov')
  }

  parseAuxData(bytes: Buffer, offset: number) {
    const formatFlags = bytes.readInt32LE(offset)
    const coordinateType =
      formatFlags & 0x10000 ? 'zero-based-half-open' : '1-based-closed'
    const format = { 0: 'generic', 1: 'SAM', 2: 'VCF' }[formatFlags & 0xf]
    if (!format) {
      throw new Error(`invalid Tabix preset format flags ${formatFlags}`)
    }
    const columnNumbers = {
      ref: bytes.readInt32LE(offset + 4),
      start: bytes.readInt32LE(offset + 8),
      end: bytes.readInt32LE(offset + 12),
    }
    const metaValue = bytes.readInt32LE(offset + 16)
    const metaChar = metaValue ? String.fromCharCode(metaValue) : null
    const skipLines = bytes.readInt32LE(offset + 20)
    const nameSectionLength = bytes.readInt32LE(offset + 24)

    const { refIdToName, refNameToId } = this._parseNameBytes(
      bytes.slice(offset + 28, offset + 28 + nameSectionLength),
    )

    return {
      refIdToName,
      refNameToId,
      skipLines,
      metaChar,
      columnNumbers,
      format,
      coordinateType,
    }
  }

  _parseNameBytes(namesBytes: Buffer) {
    let currRefId = 0
    let currNameStart = 0
    const refIdToName = []
    const refNameToId: { [key: string]: number } = {}
    for (let i = 0; i < namesBytes.length; i += 1) {
      if (!namesBytes[i]) {
        if (currNameStart < i) {
          let refName = namesBytes.toString('utf8', currNameStart, i)
          refName = this.renameRefSeq(refName)
          refIdToName[currRefId] = refName
          refNameToId[refName] = currRefId
        }
        currNameStart = i + 1
        currRefId += 1
      }
    }
    return { refNameToId, refIdToName }
  }

  // fetch and parse the index

  async _parse(opts: Options = {}) {
    const bytes = await unzip((await this.filehandle.readFile(opts)) as Buffer)

    // check TBI magic numbers
    let csiVersion
    if (bytes.readUInt32LE(0) === CSI1_MAGIC) {
      csiVersion = 1
    } else if (bytes.readUInt32LE(0) === CSI2_MAGIC) {
      csiVersion = 2
    } else {
      throw new Error('Not a CSI file')
      // TODO: do we need to support big-endian CSI files?
    }

    this.minShift = bytes.readInt32LE(4)
    this.depth = bytes.readInt32LE(8)
    this.maxBinNumber = ((1 << ((this.depth + 1) * 3)) - 1) / 7
    const maxRefLength = 2 ** (this.minShift + this.depth * 3)
    const auxLength = bytes.readInt32LE(12)
    const aux =
      auxLength && auxLength >= 30
        ? this.parseAuxData(bytes, 16)
        : {
            refIdToName: [],
            refNameToId: {},
            metaChar: null,
            columnNumbers: { ref: 0, start: 1, end: 2 },
            coordinateType: 'zero-based-half-open',
            format: 'generic',
          }
    const refCount = bytes.readInt32LE(16 + auxLength)

    // read the indexes for each reference sequence
    let firstDataLine: VirtualOffset | undefined
    let currOffset = 16 + auxLength + 4
    const indices = new Array(refCount).fill(0).map(() => {
      // the binning index
      const binCount = bytes.readInt32LE(currOffset)
      currOffset += 4
      const binIndex: { [key: string]: Chunk[] } = {}
      let stats // < provided by parsing a pseudo-bin, if present
      for (let j = 0; j < binCount; j += 1) {
        const bin = bytes.readUInt32LE(currOffset)
        if (bin > this.maxBinNumber) {
          // this is a fake bin that actually has stats information
          // about the reference sequence in it
          stats = this.parsePseudoBin(bytes, currOffset + 4)
          currOffset += 4 + 8 + 4 + 16 + 16
        } else {
          const loffset = fromBytes(bytes, currOffset + 4)
          firstDataLine = this._findFirstData(firstDataLine, loffset)
          const chunkCount = bytes.readInt32LE(currOffset + 12)
          currOffset += 16
          const chunks = new Array(chunkCount)
          for (let k = 0; k < chunkCount; k += 1) {
            const u = fromBytes(bytes, currOffset)
            const v = fromBytes(bytes, currOffset + 8)
            currOffset += 16
            // this._findFirstData(data, u)
            chunks[k] = new Chunk(u, v, bin)
          }
          binIndex[bin] = chunks
        }
      }

      return { binIndex, stats }
    })

    return {
      ...aux,
      csi: true,
      refCount,
      maxBlockSize: 1 << 16,
      firstDataLine,
      csiVersion,
      indices,
      depth: this.depth,
      maxBinNumber: this.maxBinNumber,
      maxRefLength,
    }
  }

  parsePseudoBin(bytes: Buffer, offset: number) {
    const lineCount = longToNumber(
      Long.fromBytesLE(
        bytes.slice(offset + 28, offset + 36) as unknown as number[],
        true,
      ),
    )
    return { lineCount }
  }

  async blocksForRange(
    refName: string,
    min: number,
    max: number,
    opts: Options = {},
  ) {
    if (min < 0) {
      min = 0
    }

    const indexData = await this.parse(opts)
    if (!indexData) {
      return []
    }
    const refId = indexData.refNameToId[refName]
    const ba = indexData.indices[refId]
    if (!ba) {
      return []
    }

    // const { linearIndex, binIndex } = indexes

    const overlappingBins = this.reg2bins(min, max) // List of bin #s that overlap min, max
    const chunks: Chunk[] = []

    // Find chunks in overlapping bins.  Leaf bins (< 4681) are not pruned
    for (const [start, end] of overlappingBins) {
      for (let bin = start; bin <= end; bin++) {
        if (ba.binIndex[bin]) {
          const binChunks = ba.binIndex[bin]
          for (let c = 0; c < binChunks.length; ++c) {
            chunks.push(new Chunk(binChunks[c].minv, binChunks[c].maxv, bin))
          }
        }
      }
    }

    return optimizeChunks(chunks, new VirtualOffset(0, 0))
  }

  /**
   * calculate the list of bins that may overlap with region [beg,end) (zero-based half-open)
   */
  reg2bins(beg: number, end: number) {
    beg -= 1 // < convert to 1-based closed
    if (beg < 1) {
      beg = 1
    }
    if (end > 2 ** 50) {
      end = 2 ** 34
    } // 17 GiB ought to be enough for anybody
    end -= 1
    let l = 0
    let t = 0
    let s = this.minShift + this.depth * 3
    const bins = []
    for (; l <= this.depth; s -= 3, t += lshift(1, l * 3), l += 1) {
      const b = t + rshift(beg, s)
      const e = t + rshift(end, s)
      if (e - b + bins.length > this.maxBinNumber) {
        throw new Error(
          `query ${beg}-${end} is too large for current binning scheme (shift ${this.minShift}, depth ${this.depth}), try a smaller query or a coarser index binning scheme`,
        )
      }
      bins.push([b, e])
    }
    return bins
  }
}
