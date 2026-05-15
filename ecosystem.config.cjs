module.exports = {
  apps: [
    {
      name: 'max-g4f-bot',
      cwd: '/opt/max-g4f-bot',
      script: 'src/index.js',
      interpreter: '/usr/bin/node',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'max-g4f-admin',
      cwd: '/opt/max-g4f-bot',
      script: 'src/admin.js',
      interpreter: '/usr/bin/node',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'odin-gpt-bot',
      cwd: '/opt/max-g4f-bot',
      script: 'src/telegram.js',
      interpreter: '/usr/bin/node',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
