import { loadConfig, readiness } from '../src/config';
import { localSettings } from './local-settings';
const settings = process.argv.includes('--local') ? await localSettings() : process.env;
const { config, routing } = loadConfig(settings);
console.log(JSON.stringify(readiness(config, routing, settings), null, 2));
