import ignore, { type Ignore } from 'ignore';

/** Build output, dependencies, caches and binaries that never deserve a note. */
export const DEFAULT_IGNORE = [
  // dependencies / envs
  'node_modules/', 'bower_components/', 'vendor/bundle/', '.venv/', 'venv/', 'env/', 'Pods/', 'Carthage/',
  // build output
  'dist/', 'build/', 'out/', '.build/', 'DerivedData/', 'target/', '.next/', '.nuxt/', '.svelte-kit/',
  '.turbo/', '.parcel-cache/', '.cache/', 'coverage/', '.gradle/', '.swiftpm/', 'xcuserdata/',
  '*.xcodeproj/', '*.xcworkspace/', '*.xcassets/', '*.dSYM/', '*.app/', '*.framework/', '*.xcframework/',
  '__pycache__/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.tox/', '.ipynb_checkpoints/',
  // compiler artifacts
  '*.o', '*.a', '*.so', '*.dylib', '*.pcm', '*.d', '*.dia', '*.swiftdeps', '*.swiftmodule', '*.swiftdoc',
  '*.swiftsourceinfo', '*.swiftconstvalues', '*.hmap', '*.tbd', '*.pyc', '*.pyo', '*.class', '*.jar',
  '*.msgpack', '*.xcbuilddata', '*.exe', '*.dll', '*.wasm', '*.map',
  // archives / installers / media blobs
  '*.dmg', '*.pkg', '*.zip', '*.tar', '*.gz', '*.tgz', '*.7z', '*.rar', '*.iso',
  '*.mp4', '*.mov', '*.avi', '*.mkv', '*.wav', '*.mp3', '*.m4a', '*.flac',
  '*.onnx', '*.pt', '*.pth', '*.safetensors', '*.ckpt', '*.bin', '*.gguf', '*.h5', '*.npy', '*.npz', '*.parquet',
  '*.sqlite', '*.sqlite3', '*.db', '*.db-*',
  // lockfiles & noise
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Podfile.lock', 'Cargo.lock', 'poetry.lock',
  'uv.lock', '*.log', '.DS_Store', 'Thumbs.db',
];

/** Hidden entries are skipped except these. */
const HIDDEN_ALLOW = new Set(['.github', '.gitignore', '.env.example', '.cursorrules']);

export function isHiddenSkipped(name: string): boolean {
  return name.startsWith('.') && !HIDDEN_ALLOW.has(name);
}

export function makeIgnore(extra: string[] = []): Ignore {
  return ignore().add(DEFAULT_IGNORE).add(extra);
}

/** Scoped ignore stack: nested .gitignore files apply relative to their own dir. */
export class IgnoreStack {
  private layers: { base: string; ig: Ignore }[];

  constructor(root: Ignore) {
    this.layers = [{ base: '', ig: root }];
  }

  child(base: string, gitignoreText: string | null): IgnoreStack {
    if (!gitignoreText) return this;
    const next = new IgnoreStack(this.layers[0].ig);
    next.layers = [...this.layers, { base, ig: ignore().add(gitignoreText) }];
    return next;
  }

  /** `rel` is project-relative posix; append '/' for directories. */
  ignores(rel: string): boolean {
    for (const { base, ig } of this.layers) {
      const local = base ? (rel.startsWith(base + '/') ? rel.slice(base.length + 1) : null) : rel;
      if (local && ig.ignores(local)) return true;
    }
    return false;
  }
}
