import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const templatePath = process.argv[2];
if (!templatePath) throw new Error('Usage: node watch/prepare-project.mjs <DevEco JS FA project directory>');

const main = resolve(templatePath, 'entry', 'src', 'main');
const manifestPath = join(main, 'config.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
const moduleConfig = manifest.module;
const relayUrl = (process.env.WATCH_RELAY_URL || '').replace(/\/+$/, '');
const token = process.env.WATCH_TOKEN || '';
const backup = process.env.WATCH_RELAY_IPV4 || '';
if (backup && isIP(backup) !== 4) throw new Error('WATCH_RELAY_IPV4 must be a verified IPv4 address');
if (relayUrl || token) {
  const parsed = new URL(relayUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search
      || parsed.hash || token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('WATCH_RELAY_URL must be HTTPS and WATCH_TOKEN must be at least 32 URL-safe characters');
  }
}

if (manifest.app.bundleName === 'com.hero.watchvoice.archive' && !moduleConfig.js?.length) {
  const settings = join(main, 'java', 'com', 'hero', 'watchvoice', 'archive', 'RelaySettings.java');
  if (!existsSync(settings)) throw new Error('Cannot locate the native WATCH 3 RelaySettings.java');
  const source = readFileSync(settings, 'utf8');
  const updated = source
    .replace(/(static final String URL = )"[^"\r\n]*";/, (_, prefix) => prefix + JSON.stringify(relayUrl) + ';')
    .replace(/(static final String TOKEN = )"[^"\r\n]*";/, (_, prefix) => prefix + JSON.stringify(token) + ';')
    .replace(/(static final String IPV4_BACKUP = )"[^"\r\n]*";/, (_, prefix) => prefix + JSON.stringify(backup) + ';');
  if (!updated.includes('static final String URL = ' + JSON.stringify(relayUrl) + ';')
      || !updated.includes('static final String TOKEN = ' + JSON.stringify(token) + ';')) {
    throw new Error('Unexpected WATCH 3 RelaySettings.java structure');
  }
  writeFileSync(settings, updated);
  console.log('HTTPS settings saved in the native WATCH 3 project.');
  process.exit(0);
}

const pages = moduleConfig?.abilities?.filter(ability => ability.type === 'page');
if (pages?.length !== 1 || moduleConfig.js?.length !== 1) {
  throw new Error('Use a new DevEco JS FA template with one page ability and one JS component');
}
const [ability] = pages;
const [component] = moduleConfig.js;
const componentFolder = ability.srcPath || component.name;
if (!/^[a-zA-Z0-9_-]+$/.test(componentFolder)) throw new Error('Unexpected JS component directory');
const destination = join(main, 'js', componentFolder);
if (!existsSync(join(destination, 'app.js'))) {
  throw new Error('Cannot locate the generated JS FA template app.js');
}
moduleConfig.deviceType = ['wearable'];
component.pages = ['pages/index/index'];
component.window = { designWidth: 466, autoDesignWidth: false };
moduleConfig.reqPermissions = (moduleConfig.reqPermissions || [])
  .filter(permission => !['ohos.permission.INTERNET', 'ohos.permission.MICROPHONE'].includes(permission.name));
moduleConfig.reqPermissions.push(
  { name: 'ohos.permission.INTERNET' },
  {
    name: 'ohos.permission.MICROPHONE',
    reason: '$string:watch_mic_reason',
    usedScene: { ability: [ability.name], when: 'inuse' },
  },
);

const stringsPath = join(main, 'resources', 'base', 'element', 'string.json');
const strings = JSON.parse(readFileSync(stringsPath, 'utf8').replace(/^\uFEFF/, ''));
strings.string = strings.string.filter(entry => entry.name !== 'watch_mic_reason' && entry.name !== 'watch_app_name');
strings.string.push(
  { name: 'watch_mic_reason', value: '用于录制您在手表上发起的语音。' },
  { name: 'watch_app_name', value: '飞录' },
);
ability.label = '$string:watch_app_name';

const source = fileURLToPath(new URL('./entry/src/main/js/MainAbility/', import.meta.url));
cpSync(source, destination, { recursive: true });
writeFileSync(join(destination, 'common', 'relay-config.js'),
  'export const relayUrl = ' + JSON.stringify(relayUrl) + ';\n'
  + 'export const watchToken = ' + JSON.stringify(token) + ';\n');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(stringsPath, JSON.stringify(strings, null, 2) + '\n');
console.log('Wearable source copied to the DevEco project.');
