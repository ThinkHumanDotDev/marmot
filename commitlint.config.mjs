const config = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'engine',
        'collections',
        'access',
        'auth',
        'ui',
        'realtime',
        'notifications',
        'status-pages',
        'maintenance',
        'monitors',
        'stats',
        'infra',
        'docker',
        'ci',
        'docs',
        'deps',
        'tests',
        'billing',
        'telemetry',
        'api',
        'email',
        'settings',
        'release',
      ],
    ],
    'subject-case': [0],
  },
}

export default config
