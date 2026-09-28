import { extname, basename } from 'node:path';

const BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.ipynb': 'jupyter', '.swift': 'swift', '.m': 'objc', '.mm': 'objc', '.h': 'c',
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.lua': 'lua',
  '.sh': 'shell', '.zsh': 'shell', '.bash': 'shell', '.fish': 'shell', '.ps1': 'powershell',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
  '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro',
  '.md': 'markdown', '.mdx': 'markdown', '.txt': 'text', '.rtf': 'rtf', '.tex': 'latex',
  '.json': 'json', '.jsonc': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml',
  '.plist': 'plist', '.ini': 'ini', '.env': 'env', '.csv': 'csv', '.tsv': 'csv', '.sql': 'sql',
  '.graphql': 'graphql', '.proto': 'protobuf', '.dockerfile': 'docker',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'svg',
  '.ico': 'image', '.icns': 'image', '.heic': 'image', '.pdf': 'pdf', '.docx': 'word', '.xlsx': 'excel',
  '.pptx': 'powerpoint', '.entitlements': 'plist', '.strings': 'strings', '.metal': 'metal',
};

const BY_NAME: Record<string, string> = {
  Dockerfile: 'docker', Makefile: 'make', Gemfile: 'ruby', Podfile: 'ruby', Procfile: 'text',
  '.gitignore': 'gitignore', LICENSE: 'text',
};

export function langOf(path: string): string {
  const name = basename(path);
  return BY_NAME[name] ?? BY_EXT[extname(name).toLowerCase()] ?? (extname(name).slice(1).toLowerCase() || 'text');
}
