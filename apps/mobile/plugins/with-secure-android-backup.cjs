/* eslint-disable @typescript-eslint/no-require-imports -- Expo and Jest config plugins are CommonJS entrypoints. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const backupRules = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
  <exclude domain="database" path="." />
  <exclude domain="sharedpref" path="." />
  <exclude domain="file" path="." />
  <exclude domain="external" path="." />
</full-backup-content>
`;

const dataExtractionRules = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="database" path="." />
    <exclude domain="sharedpref" path="." />
    <exclude domain="file" path="." />
    <exclude domain="external" path="." />
  </cloud-backup>
  <device-transfer>
    <exclude domain="database" path="." />
    <exclude domain="sharedpref" path="." />
    <exclude domain="file" path="." />
    <exclude domain="external" path="." />
  </device-transfer>
</data-extraction-rules>
`;

function withSecureAndroidBackup(config) {
  config = withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('The generated Android manifest has no application node.');
    }
    application.$ ??= {};
    application.$['android:allowBackup'] = 'false';
    application.$['android:usesCleartextTraffic'] = 'false';
    application.$['android:fullBackupContent'] = '@xml/backup_rules';
    application.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    return modConfig;
  });

  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const xmlDirectory = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app/src/main/res/xml',
      );
      await fs.mkdir(xmlDirectory, { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(xmlDirectory, 'backup_rules.xml'), backupRules, 'utf8'),
        fs.writeFile(
          path.join(xmlDirectory, 'data_extraction_rules.xml'),
          dataExtractionRules,
          'utf8',
        ),
      ]);
      return modConfig;
    },
  ]);
}

module.exports = withSecureAndroidBackup;
