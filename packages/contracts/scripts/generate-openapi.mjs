import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateOpenApiYaml } from '../dist/src/openapi.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDirectory, '../../../docs/reference/openapi.yaml');
await writeFile(outputPath, generateOpenApiYaml(), 'utf8');
