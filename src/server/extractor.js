// @flow

import fs from 'fs';
import path from 'path';
import globby from 'globby';
import sane from 'sane';
import { clone, merge, addLast } from 'timm';
import { mainStory, chalk } from 'storyboard';
import type { StoryT } from 'storyboard';
import { HTML_PREVIEW_SEPARATOR } from '../serializer';
import type {
  FilePathT,
  FolderPathT,
  FolderT,
  SnapshotSuiteT,
} from '../common/types';

type ConfigT = {|
  snapshotPatterns: Array<string>,
  cssPatterns: Array<string>,
  watch: boolean,
  socketioServer: Object,
|};

type SnapshotSuiteDictT = { [filePath: FilePathT]: SnapshotSuiteT };
type FolderDictT = { [folderPath: FolderPathT]: FolderT };

let _config: ConfigT;
let _snapshotSuiteDict: SnapshotSuiteDictT = {};
let _commonCss: Array<string> = [];
let _folderDict: FolderDictT = {};
let _watcher = null;

const configure = (newConfig: $Shape<ConfigT>) => {
  if (!_config) {
    _config = clone(newConfig);
    return;
  }
  _config = (merge(_config, newConfig): any);
};

const start = ({ story = mainStory }: { story: StoryT } = {}) => {
  refresh(story);
  if (_config.watch) watchStart(story);
};

const refresh = (story: StoryT = mainStory) => {
  const childStory = story.child({ src: 'extractor', title: 'Refresh snapshots' });
  return Promise.resolve()
  .then(() => extractCommonCss(_config, story).then((css) => { _commonCss = css; }))
  .then(() => globby(_config.snapshotPatterns))
  .then((filePaths) => {
    childStory.info('extractor', 'Reading snapshot files...');
    const extractedSnapshots: SnapshotSuiteDictT = {};
    filePaths.forEach((filePath) => {
      const suite = extractSnapshots(filePath, _commonCss, childStory);
      const finalFilePath = `-/${filePath}`;
      suite.__folderPath = path.dirname(finalFilePath);
      extractedSnapshots[finalFilePath] = suite;
    });
    _snapshotSuiteDict = extractedSnapshots;
    childStory.info('extractor', 'Building tree...');
    _folderDict = buildFolderDict(_snapshotSuiteDict, childStory);
    childStory.debug('extractor', 'Snapshot tree:', { attach: _folderDict });
    childStory.close();
    broadcastSignal();
  })
  .catch((err) => {
    childStory.close();
    throw err;
  });
};

const extractCommonCss = (config: ConfigT, story: StoryT): Promise<Array<string>> => {
  story.info('extractor', 'Extracting common CSS...');
  return Promise.resolve()
  .then(() => globby(config.cssPatterns))
  .then((cssPaths) =>
    cssPaths.map((cssPath) => {
      story.info('extractor', `Processing ${chalk.cyan.bold(cssPath)}...`);
      return fs.readFileSync(cssPath, 'utf8');
    })
  );
};

const extractSnapshots = (
  filePath: string,
  commonCss: Array<string>,
  story: StoryT
): SnapshotSuiteT => {
  story.info('extractor', `Processing ${chalk.cyan.bold(filePath)}...`);
  const absPath = path.resolve(process.cwd(), filePath);
  let suiteCss;
  try {
    const cssPath = getCssPathForSuite(filePath);
    story.debug('extractor', `Trying to read ${chalk.cyan.bold(cssPath)}...`);
    suiteCss = fs.readFileSync(cssPath, 'utf8');
    story.info('extractor', `Found custom CSS in ${chalk.cyan.bold(cssPath)}`);
  } catch (err) { /* no file exists */ }
  const rawSnapshots = loadSnapshot(absPath);
  const out: SnapshotSuiteT = {};
  Object.keys(rawSnapshots).forEach((id) => {
    const snapshot = rawSnapshots[id];
    const [snap, html] = snapshot.split(HTML_PREVIEW_SEPARATOR);
    const css = suiteCss != null ? addLast(commonCss, suiteCss) : commonCss;
    out[id] = { id, snap, html, css };
  });
  story.debug('extractor', `Found ${Object.keys(rawSnapshots).length} snapshots`);
  return out;
};

const loadSnapshot = (absPath: string): Object => {
  /* eslint-disable global-require, import/no-dynamic-require */
  delete require.cache[require.resolve(absPath)];
  return require(absPath);
  /* eslint-enable global-require */
};

const buildFolderDict = (snapshotSuite: SnapshotSuiteDictT, story: StoryT): FolderDictT => {
  story.debug('extractor', 'Building folder tree...');
  const out: FolderDictT = {};

  // Sort file paths to simplify tree generation
  const filePaths: Array<FilePathT> = Object.keys(snapshotSuite).sort();

  // Create root node
  let curFolderPath: FolderPathT = '-';
  let curFolder: FolderT = {
    folderPath: '-',
    filePaths: [],
    parentFolderPath: null,
    childrenFolderPaths: [],
  };
  out['-'] = curFolder;

  story.debug('extractor', 'Snapshot tree:', { attach: out });

  // Process all file paths
  filePaths.forEach((filePath) => {
    story.debug('extractor', `File: ${filePath}`);
    const folderPath: FolderPathT = path.dirname(filePath);
    if (folderPath === curFolderPath) {
      curFolder.filePaths.push(filePath);
    } else {
      let parentFolderPath = folderPath;
      let fFound = false;
      while (!fFound) {
        if (parentFolderPath === '-') break;
        parentFolderPath = path.dirname(parentFolderPath);
        if (out[parentFolderPath]) {
          fFound = true;
          break;
        }
      }
      if (!fFound) throw new Error('Error building path tree');
      out[parentFolderPath].childrenFolderPaths.push(folderPath);
      curFolder = out[folderPath] = {
        folderPath,
        filePaths: [filePath],
        parentFolderPath,
        childrenFolderPaths: [],
      };
      curFolderPath = folderPath;
    }
  });
  return out;
};

const getFolder = (folderPath: FolderPathT): ?FolderT => _folderDict[folderPath];
const getSnapshotSuite = (filePath: FilePathT): ?SnapshotSuiteT => _snapshotSuiteDict[filePath];

const getCssPathForSuite = (filePath: FilePathT): string => {
  const { dir, name } = path.parse(filePath);
  return path.join(dir, `${name}.css`);
};

const watchStart = (story: StoryT) => {
  if (_watcher) return;
  const glob = _config.snapshotPatterns.concat(_config.cssPatterns);
  _watcher = sane('.', { glob });
  const refreshWrapper = () => refresh();
  _watcher.on('change', refreshWrapper);
  _watcher.on('add', refreshWrapper);
  _watcher.on('delete', refreshWrapper);
  story.info('extractor', 'Started watching over snapshot and CSS files');
};

// const watchStop = (story: StoryT) => {
//   if (_watcher == null) return;
//   _watcher.close();
//   _watcher = null;
//   story.info('extractor', 'Stopped file watcher');
// };

const broadcastSignal = () => {
  if (!_config.socketioServer) return;
  _config.socketioServer.emit('REFRESH');
};

// =============================================
// Public API
// =============================================
export {
  configure,
  start,
  getFolder,
  getSnapshotSuite,
};
