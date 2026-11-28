import base from './vitest.coverage.config';

// 针对 Google Drive / WebDAV 的事务与协议验证；保持完整覆盖率阈值，不运行无关产品套件。
export default {
    ...base,
    test: {
        ...base.test,
        // 多次真实 PBKDF2 派生在限流或并行构建时可能超过默认 5 秒。
        testTimeout: 30_000,
        include: [
            'tests/googleDrivePreview.test.ts',
            'tests/googleDriveConfig.test.ts',
            'tests/webDavBackup.test.ts',
            'tests/webDavHttpIntegration.test.ts',
            'tests/webDavConnection.test.ts',
            'tests/webDavApi.test.ts',
            'tests/webDavProperties.test.ts',
            'tests/googleDriveApi.test.ts',
            'tests/googleDriveAuth.test.ts',
            'tests/googleDriveEncryption.test.ts',
            'tests/backgroundWebDavBackup.test.ts',
            'tests/webDavBackupClient.test.ts',
            'tests/googleDriveSyncClient.test.ts',
            'tests/googleDriveSync.test.ts',
            'tests/backgroundGoogleDriveSync.test.ts',
        ],
        coverage: {
            ...base.test?.coverage,
            reportsDirectory: 'coverage/cloud-backup',
            include: [
                'src/features/settings/model/googleDrivePreview.ts',
                'src/core/config/cloudSync.ts',
                'src/core/config/driveSync.ts',
                'src/platform/webdav/connection.ts',
                'src/platform/webdav/api.ts',
                'src/platform/webdav/properties.ts',
                'src/platform/google-drive/api.ts',
                'src/platform/google-drive/auth.ts',
                'src/platform/google-drive/encryption.ts',
                'src/services/config/remoteConfigSync.ts',
                'src/services/config/webDavBackup.ts',
                'src/services/config/cloudBackupClient.ts',
                'src/services/config/webDavBackupClient.ts',
                'src/services/config/googleDriveSync.ts',
                'src/services/config/googleDriveSyncClient.ts',
                'src/app/background/handlers/webDavBackup.ts',
                'src/app/background/handlers/googleDriveSync.ts',
            ],
        },
    },
};
