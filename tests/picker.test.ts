import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PICKER_OUTPUT_PREAMBLE, decodePickerOutput, pickerScript } from '../src/index.js'

/**
 * Cover for the native picker's transcription path.
 *
 * The picker is the one part of the panel that cannot be driven without a human
 * clicking a dialog, so the previous shape shipped with `toString('utf16le')`
 * on a stream that `powershell.exe` actually encodes in the console code page
 * (CP936 here). Every picked path came back as mojibake — including plain
 * ASCII ones, because byte pairs were being recombined. These tests pin the
 * contract from both ends: the encoding the script requests, and the decoder.
 */

/** A path with the non-ASCII shape this machine really uses. */
const CHINESE_PATH = 'D:\\code\\提示词\\dsh-safe-plugin'

/** The same path as CP936 bytes — what powershell.exe emits without the preamble. */
const CHINESE_PATH_GBK = Buffer.from([
  0x44, 0x3a, 0x5c, 0x63, 0x6f, 0x64, 0x65, 0x5c, 0xcc, 0xe1, 0xca, 0xbe, 0xb4, 0xca, 0x5c, 0x64,
  0x73, 0x68, 0x2d, 0x73, 0x61, 0x66, 0x65, 0x2d, 0x70, 0x6c, 0x75, 0x67, 0x69, 0x6e,
])

function runPowerShell(script: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', () => resolve(Buffer.concat(chunks)))
  })
}

const onWindows = process.platform === 'win32' ? it : it.skip

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

describe('picker output transcription', () => {
  it('decodes the UTF-8 the picker script pins', () => {
    expect(decodePickerOutput(Buffer.from(CHINESE_PATH, 'utf8'))).toBe(CHINESE_PATH)
  })

  it('keeps a plain ASCII path intact', () => {
    expect(decodePickerOutput(Buffer.from('D:\\backups\\dsh\r\n', 'utf8'))).toBe('D:\\backups\\dsh')
  })

  it('strips a trailing newline, NUL padding and a leading BOM', () => {
    expect(decodePickerOutput(Buffer.from('D:\\backup\u0000\u0000', 'utf8'))).toBe('D:\\backup')
    expect(
      decodePickerOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('D:\\b', 'utf8')])),
    ).toBe('D:\\b')
  })

  it('shows why the script must pin the encoding', () => {
    // CP936 bytes are not UTF-8, and decoding them as UTF-16LE — the previous
    // implementation — is what produced garbled paths in the panel.
    expect(decodePickerOutput(CHINESE_PATH_GBK)).not.toBe(CHINESE_PATH)
    expect(CHINESE_PATH_GBK.toString('utf16le')).not.toBe(CHINESE_PATH)
  })

  it('pins the console encoding before anything writes to stdout', () => {
    for (const kind of ['directory', 'file'] as const) {
      const script = pickerScript(kind)
      expect(script.startsWith(PICKER_OUTPUT_PREAMBLE)).toBe(true)
      expect(script).toContain('Add-Type -AssemblyName System.Windows.Forms')
    }
  })

  it('asks for a folder dialog when picking a directory', () => {
    const script = pickerScript('directory')
    expect(script).toContain('System.Windows.Forms.FolderBrowserDialog')
    expect(script).toContain('$dlg.ShowNewFolderButton = $true')
    expect(script).toContain('[Console]::Out.Write($dlg.SelectedPath)')
  })

  it('asks for a filtered file dialog when picking a migration package', () => {
    const script = pickerScript('file')
    expect(script).toContain('System.Windows.Forms.OpenFileDialog')
    expect(script).toContain('$dlg.CheckFileExists = $true')
    expect(script).toContain('*.dsh-migrate')
    expect(script).toContain('[Console]::Out.Write($dlg.FileName)')
  })

  it('escapes an apostrophe so a path cannot break out of the literal', () => {
    // The dialog values are the only interpolated strings; a stray quote there
    // would end the literal and turn the rest of the path into PowerShell code.
    expect(pickerScript('file')).not.toMatch(/\$dlg\.Filter = '[^']*[^']'[^;]/)
  })

  onWindows('round-trips a Chinese path through real powershell.exe', async () => {
    const stdout = await runPowerShell(
      `${PICKER_OUTPUT_PREAMBLE}; [Console]::Out.Write(${literal(CHINESE_PATH)})`,
    )
    expect(decodePickerOutput(stdout)).toBe(CHINESE_PATH)
  })

  onWindows('loses the path when the preamble is dropped', async () => {
    // Falsification: without the preamble the same script is unreadable, which
    // is exactly the defect this fix removes.
    const stdout = await runPowerShell(`[Console]::Out.Write(${literal(CHINESE_PATH)})`)
    expect(decodePickerOutput(stdout)).not.toBe(CHINESE_PATH)
  })
})
