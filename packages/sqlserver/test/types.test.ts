import { describe, expect, it } from 'vitest'
import { Cursor } from '../src/tds.js'
import { bytesOf, codePage, decodeText, encodeText, readTypeInfo, readValue, textOf, TYPE, writeValue, type TypeInfo } from '../src/types.js'

const LATIN1 = Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34])

/** A TYPE_INFO as SQL Server writes one, read back. */
const info = (...bytes: number[]): TypeInfo => readTypeInfo(new Cursor(Buffer.from(bytes)))

describe('each type, as text and back', () => {
  it.each<[string, TypeInfo, string]>([
    ['tinyint', info(TYPE.INTN, 1), '200'],
    ['smallint', info(TYPE.INTN, 2), '-12345'],
    ['int', info(TYPE.INT4), '2147483647'],
    ['bigint', info(TYPE.INTN, 8), '9007199254740993'],
    ['bit', info(TYPE.BITN, 1), '1'],
    ['float', info(TYPE.FLTN, 8), '3.14159265358979'],
    ['real', info(TYPE.FLTN, 4), '2.5'],
    ['money', info(TYPE.MONEYN, 8), '922337203685.4775'],
    ['negative money', info(TYPE.MONEYN, 8), '-12.3400'],
    ['smallmoney', info(TYPE.MONEYN, 4), '214748.3647'],
    ['decimal(10, 2)', info(TYPE.DECIMALN, 5, 10, 2), '-512.87'],
    ['numeric(20, 5)', info(TYPE.NUMERICN, 9, 20, 5), '123456789012345.12345'],
    ['date', info(TYPE.DATE), '2024-02-29'],
    ['date in year 1', info(TYPE.DATE), '0001-01-01'],
    ['time(3)', info(TYPE.TIME, 3), '23:59:59.997'],
    ['time(0)', info(TYPE.TIME, 0), '08:30:00'],
    ['datetime', info(TYPE.DATETIMN, 8), '2025-03-14 09:26:53.590'],
    ['smalldatetime', info(TYPE.DATETIMN, 4), '2025-03-14 09:27:00'],
    ['datetime2(7)', info(TYPE.DATETIME2, 7), '2025-03-14 09:26:53.5891234'],
    ['datetimeoffset(7)', info(TYPE.DATETIMEOFFSET, 7), '2025-03-14 09:26:53.5891234+05:30'],
    ['datetimeoffset west of UTC', info(TYPE.DATETIMEOFFSET, 0), '2025-04-03 12:00:00-05:00'],
    ['uniqueidentifier', info(TYPE.GUID, 16), 'D3ADB33F-0000-4000-8000-C0FFEE000001'],
    ['varchar(20)', info(TYPE.BIGVARCHAR, 20, 0, ...LATIN1), 'Café'],
    ['nvarchar(40)', info(TYPE.NVARCHAR, 80, 0, ...LATIN1), 'Žluťoučký kůň'],
    ['varbinary(16)', info(TYPE.BIGVARBINARY, 16, 0), '\\xdeadbeef'],
  ])('%s', (_, type, text) => {
    const bytes = bytesOf(type, text)!
    expect(bytes).toBeDefined()
    expect(textOf(type, bytes)).toBe(text)
    // As a row carries it, and read back.
    const read = readValue(new Cursor(writeValue(type, { bytes })), type)
    expect(read.bytes).toEqual(bytes)
  })

  it('reads SQL Server’s own bytes for a uniqueidentifier, its first three groups little-endian', () => {
    const bytes = Buffer.from('3fb3add3000000408000c0ffee000001', 'hex')
    expect(textOf(info(TYPE.GUID, 16), bytes)).toBe('D3ADB33F-0000-4000-8000-C0FFEE000001')
  })

  it('keeps a fake within its type: a tinyint unsigned, a decimal within its precision, char(n) padded', () => {
    expect(bytesOf(info(TYPE.INTN, 1), '-5')).toEqual(Buffer.from([0]))
    expect(textOf(info(TYPE.DECIMALN, 5, 4, 2), bytesOf(info(TYPE.DECIMALN, 5, 4, 2), '123456.78')!)).toBe('99.99')
    const char5 = info(TYPE.BIGCHAR, 5, 0, ...LATIN1)
    expect(bytesOf(char5, 'ab', Buffer.from('Quill'))).toEqual(Buffer.from('ab   '))
    const nvarchar3 = info(TYPE.NVARCHAR, 6, 0, ...LATIN1)
    expect(textOf(nvarchar3, bytesOf(nvarchar3, 'abcdef')!)).toBe('abc')
  })

  it('writes a max type in chunks, and null as PLP does', () => {
    const max = info(TYPE.NVARCHAR, 0xff, 0xff, ...LATIN1)
    expect(max.layout).toBe('plp')
    const written = writeValue(max, { bytes: Buffer.from('hello', 'utf16le') })
    expect(readValue(new Cursor(written), max).bytes!.toString('utf16le')).toBe('hello')
    expect(readValue(new Cursor(writeValue(max, { bytes: null })), max).bytes).toBeNull()
  })
})

describe('collations', () => {
  it('reads a column’s code page from its collation', () => {
    expect(codePage(LATIN1)).toBe('windows-1252')
    // Czech_CI_AS: LCID 0x405, no sort order.
    expect(codePage(Buffer.from([0x05, 0x04, 0xd0, 0x00, 0x00]))).toBe('windows-1250')
    // Latin1_General_100_CI_AS_SC_UTF8: the UTF-8 flag.
    expect(codePage(Buffer.from([0x09, 0x04, 0xd0, 0x04, 0x00]))).toBe('utf-8')
  })

  it('writes a fake in its column’s code page, ? where the page has no such character', () => {
    const czech = Buffer.from([0x05, 0x04, 0xd0, 0x00, 0x00])
    expect(decodeText(encodeText('Žluťoučký', czech), czech)).toBe('Žluťoučký')
    expect(decodeText(encodeText('日本', LATIN1), LATIN1)).toBe('??')
  })
})
