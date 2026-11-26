import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { AppConfigOperatorError, assertOutsideCheckout } from './environment';
import { parseJsonRejectDuplicateMembers } from './json';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

function inside(directory: string, candidate: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return (
    pathFromDirectory === '' ||
    (!pathFromDirectory.startsWith(`..${sep}`) &&
      pathFromDirectory !== '..' &&
      !isAbsolute(pathFromDirectory))
  );
}

function requireOwned(statResult: { readonly uid?: number }): void {
  const userId = process.getuid?.();
  if (userId !== undefined && statResult.uid !== userId) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'Approval files must be owned by the current user.',
    );
  }
}

async function validateParentDirectory(path: string, checkoutRoot: string): Promise<string> {
  const parentPath = resolve(dirname(path));
  let parentStat;
  try {
    parentStat = await stat(parentPath);
  } catch {
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'The approval file directory must already exist.',
    );
  }
  if (!parentStat.isDirectory() || (parentStat.mode & 0o077) !== 0) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'The approval file directory must be a private directory with mode 0700.',
    );
  }
  requireOwned(parentStat);
  const realParent = await realpath(parentPath);
  if (inside(resolve(checkoutRoot), realParent)) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_path',
      'Approval files must be stored outside the checkout.',
    );
  }
  return realParent;
}

export async function readProtectedFile(
  candidatePath: string,
  checkoutRoot: string,
  maxBytes: number,
): Promise<Buffer> {
  const absolutePath = assertOutsideCheckout(candidatePath, checkoutRoot);
  let linkStat;
  try {
    linkStat = await lstat(absolutePath);
  } catch {
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'The required approval file is unavailable.',
    );
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'Approval files must be regular, non-symlink files.',
    );
  }
  if ((linkStat.mode & 0o077) !== 0) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'Approval files must have mode 0600 or stricter.',
    );
  }
  requireOwned(linkStat);
  if (linkStat.size > maxBytes) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'The approval file exceeds its size limit.',
    );
  }
  const actualPath = await realpath(absolutePath);
  if (inside(resolve(checkoutRoot), actualPath)) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_path',
      'Approval files must be stored outside the checkout.',
    );
  }
  await validateParentDirectory(actualPath, checkoutRoot);
  try {
    return await readFile(actualPath);
  } catch {
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'The required approval file is unavailable.',
    );
  }
}

export async function createPrivatePlanDirectory(
  directory: string,
  checkoutRoot: string,
): Promise<string> {
  if (!isAbsolute(directory)) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_path',
      'Approval files must use absolute paths.',
    );
  }
  const normalizedDirectory = resolve(directory);
  assertOutsideCheckout(normalizedDirectory, checkoutRoot);
  const root = parse(normalizedDirectory).root;
  const segments = normalizedDirectory.slice(root.length).split(sep).filter(Boolean);
  let currentPath = root;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = join(currentPath, segments[index]!);
    try {
      await lstat(currentPath);
    } catch {
      try {
        await mkdir(currentPath, { mode: PRIVATE_DIRECTORY_MODE });
      } catch {
        throw new AppConfigOperatorError(
          'app_config.unsafe_file',
          'The private plan directory could not be prepared.',
        );
      }
    }
    const directoryStat = await lstat(currentPath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new AppConfigOperatorError(
        'app_config.unsafe_file',
        'The plan directory must contain no symbolic links.',
      );
    }
    const actualPath = await realpath(currentPath);
    if (inside(resolve(checkoutRoot), actualPath)) {
      throw new AppConfigOperatorError(
        'app_config.unsafe_path',
        'Approval files must be stored outside the checkout.',
      );
    }
    const finalSegment = index === segments.length - 1;
    const unsafeMode = finalSegment
      ? (directoryStat.mode & 0o077) !== 0
      : (directoryStat.mode & 0o022) !== 0;
    if (unsafeMode) {
      throw new AppConfigOperatorError(
        'app_config.unsafe_file',
        finalSegment
          ? 'The plan directory must have mode 0700.'
          : 'The plan directory parent cannot be group or world writable.',
      );
    }
    if (finalSegment) requireOwned(directoryStat);
  }
  return await realpath(normalizedDirectory);
}

export async function writeNewPrivateFile(
  candidatePath: string,
  checkoutRoot: string,
  contents: string,
): Promise<void> {
  const absolutePath = assertOutsideCheckout(candidatePath, checkoutRoot);
  await validateParentDirectory(absolutePath, checkoutRoot);
  try {
    const handle = await open(absolutePath, 'wx', PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(absolutePath, PRIVATE_FILE_MODE);
  } catch {
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'The approval plan could not be created.',
    );
  }
}

export async function rewritePrivateFile(
  candidatePath: string,
  checkoutRoot: string,
  contents: string,
): Promise<void> {
  const absolutePath = assertOutsideCheckout(candidatePath, checkoutRoot);
  await readProtectedFile(absolutePath, checkoutRoot, 128 * 1024);
  const parentPath = await validateParentDirectory(absolutePath, checkoutRoot);
  const temporaryPath = resolve(parentPath, `.app-config-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    await rename(temporaryPath, absolutePath);
  } catch {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'The approval plan could not be updated.',
    );
  }
}

export async function readPrivateJsonFile<T>(
  candidatePath: string,
  checkoutRoot: string,
  maxBytes: number,
  parse: (value: unknown) => T,
): Promise<T> {
  const bytes = await readProtectedFile(candidatePath, checkoutRoot, maxBytes);
  try {
    const value: unknown = parseJsonRejectDuplicateMembers(bytes.toString('utf8'));
    return parse(value);
  } catch (error) {
    if (error instanceof AppConfigOperatorError) throw error;
    throw new AppConfigOperatorError(
      'app_config.unsafe_file',
      'The approval file format is invalid.',
    );
  }
}
