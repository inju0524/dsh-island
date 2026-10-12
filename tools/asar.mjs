/**
 * 极简 Electron ASAR 打包器
 * ---------------------------------------------------------------------------------------
 * 为什么需要它：桌面悬浮窗必须复用 DeepSeek Harness 自带的 Electron 运行时，
 * 而 Electron 只认 `resources/app.asar`（或 `resources/app`，实测本机只认前者）。
 * 所以插件在 Provision 阶段自己把 desktop/ 打成一个真正的 asar 归档。
 *
 * ASAR 布局（与 node 侧读取器一致）：
 *   u32 @0   = 4                     下一个 pickle 的大小
 *   u32 @4   = headerSize            = 8 + paddedJsonLen
 *   u32 @8   = headerStringSize      = paddedJsonLen
 *   u32 @12  = jsonLen
 *   json @16 (jsonLen 字节，补齐到 4 字节)
 *   data @ (8 + headerSize)
 *
 * 无外部依赖，只用 node: 内建模块。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

/**
 * 把一个目录打成 asar 归档。
 * @param dir - 源目录（递归）。
 * @returns 归档字节。
 */
export function packAsar(dir) {
  const entries = []
  const walk = (current, prefix) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const key = prefix === '' ? name : `${prefix}/${name}`
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full, key)
        continue
      }
      if (!stat.isFile()) continue
      entries.push({ key: key.split(sep).join(posix.sep), full, size: stat.size })
    }
  }
  walk(dir, '')
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const files = {}
  let offset = 0
  for (const entry of entries) {
    files[entry.key] = { size: entry.size, offset: String(offset) }
    offset += entry.size
  }

  const json = Buffer.from(JSON.stringify({ files }), 'utf8')
  const paddedJsonLen = Math.ceil(json.length / 4) * 4
  const padding = Buffer.alloc(paddedJsonLen - json.length)
  const headerSize = 8 + paddedJsonLen

  const header = Buffer.alloc(16)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(headerSize, 4)
  header.writeUInt32LE(paddedJsonLen, 8)
  header.writeUInt32LE(json.length, 12)

  const bodies = entries.map((entry) => readFileSync(entry.full))
  return Buffer.concat([header, json, padding, ...bodies])
}

/** 供自检使用：把归档解回内存里的文件表。 */
export function unpackAsar(buffer) {
  const headerSize = buffer.readUInt32LE(4)
  const jsonLen = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.toString('utf8', 16, 16 + jsonLen))
  const base = 8 + headerSize
  const out = {}
  for (const [key, value] of Object.entries(header.files ?? {})) {
    const start = base + Number(value.offset)
    out[key] = buffer.subarray(start, start + value.size)
  }
  return out
}

export { relative }
