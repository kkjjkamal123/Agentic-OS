import { execFile } from 'node:child_process';

export const shellQuote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

// Only fixed commands or paths we resolved ourselves ever reach AppleScript, never renderer text.
export function runInTerminal(command: string): Promise<void> {
  const script = `tell application "Terminal"\n  activate\n  do script ${JSON.stringify(command)}\nend tell`;
  return new Promise((resolve, reject) => execFile('osascript', ['-e', script], (err) => (err ? reject(err) : resolve())));
}
