import { decodeInput, decodeSnapshot, encodeInput, encodeSnapshot } from './binary.js'

// Один інтерфейс, дві реалізації: JSON (текстові кадри, за прапорцем ?codec=json) і бінарний (за замовчуванням).
export const codecs = {
  binary: {
    name: 'binary',
    encodeInput,
    decodeInput,
    encodeSnapshot,
    decodeSnapshot,
  },
  json: {
    name: 'json',
    encodeInput: (input) => JSON.stringify({ v: 1, type: 'input', ...input }),
    decodeInput: (data) => data, // сервер перевіряє JSON-input у protocol.js
    encodeSnapshot: (snapshot) => JSON.stringify(snapshot),
    decodeSnapshot: (data) => (typeof data === 'string' ? JSON.parse(data) : data),
  },
}
