module.exports = {
  apps: [
    {
      name: 'codex-lb',
      cwd: '/opt/codex-lb',
      script: './run.sh',
      interpreter: '/bin/bash',
      autorestart: true,
      watch: false,
      kill_timeout: 15000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
