// ── Per-instance config ────────────────────────────────────────────────────────

export interface InstanceConfig {
  id:         string
  name:       string
  serverIp:   string
  serverPort: string
  beammp: {
    apiHost:       string
    apiPort:       number
    /** Chemin dans le conteneur Docker (volume monté depuis l'hôte) */
    resourcesPath: string
    logPath:       string
    configPath:    string
  }
}

function parseInstances(): InstanceConfig[] {
  const raw = process.env.INSTANCES

  // Instance unique (pas de variable INSTANCES)
  if (!raw) {
    return [{
      id:         'default',
      name:       process.env.INSTANCE_NAME      ?? 'BeamMP Server',
      serverIp:   process.env.BEAMMP_SERVER_IP   ?? '',
      serverPort: process.env.BEAMMP_SERVER_PORT  ?? '',
      beammp: {
        apiHost:       process.env.BEAMMP_API_HOST      ?? 'localhost',
        apiPort:       parseInt(process.env.BEAMMP_API_PORT ?? '4444', 10),
        resourcesPath: process.env.BEAMMP_RESOURCES_PATH ?? '/beammp/resources',
        logPath:       process.env.BEAMMP_LOG_PATH        ?? '/beammp/server.log',
        configPath:    process.env.BEAMMP_CONFIG_PATH     ?? '/beammp/ServerConfig.toml',
      },
    }]
  }

  // Multi-instance : INSTANCES=main,event → INSTANCE_MAIN_*, INSTANCE_EVENT_*
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(id => {
    const P = `INSTANCE_${id.toUpperCase()}_`
    return {
      id,
      name:       process.env[`${P}NAME`]           ?? id,
      serverIp:   process.env[`${P}SERVER_IP`]      ?? '',
      serverPort: process.env[`${P}SERVER_PORT`]    ?? '',
      beammp: {
        apiHost:       process.env[`${P}BEAMMP_API_HOST`]       ?? 'localhost',
        apiPort:       parseInt(process.env[`${P}BEAMMP_API_PORT`] ?? '4444', 10),
        resourcesPath: process.env[`${P}BEAMMP_RESOURCES_PATH`]  ?? '/beammp/resources',
        logPath:       process.env[`${P}BEAMMP_LOG_PATH`]         ?? '/beammp/server.log',
        configPath:    process.env[`${P}BEAMMP_CONFIG_PATH`]      ?? '/beammp/ServerConfig.toml',
      },
    }
  })
}

// ── Global config ──────────────────────────────────────────────────────────────

export const config = {
  port:            parseInt(process.env.PORT ?? '3000', 10),
  jwtSecret:       process.env.JWT_SECRET ?? 'change-me',
  allowedOrigin:   process.env.ALLOWED_ORIGIN ?? '',
  localImagesPath: process.env.IMAGES_PATH ?? '/app/images',

  db: {
    host:     process.env.POSTGRES_HOST     ?? 'localhost',
    port:     parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB       ?? 'beammp',
    user:     process.env.POSTGRES_USER     ?? 'beammp',
    password: process.env.POSTGRES_PASSWORD ?? 'beammp',
  },

  discord: {
    webhookUrl:      process.env.DISCORD_WEBHOOK_URL      ?? '',
    webhookRestart:  process.env.DISCORD_WEBHOOK_RESTART  ?? '',
    webhookPlayers:  process.env.DISCORD_WEBHOOK_PLAYERS  ?? '',
    webhookMods:     process.env.DISCORD_WEBHOOK_MODS     ?? '',
    serverUrl:       process.env.DISCORD_SERVER_URL       ?? '',
    notifyJoin:      process.env.DISCORD_NOTIFY_JOIN      !== 'false',
    notifyLeave:     process.env.DISCORD_NOTIFY_LEAVE     !== 'false',
    notifyModUpload: process.env.DISCORD_NOTIFY_MOD_UPLOAD !== 'false',
    notifyRestart:   process.env.DISCORD_NOTIFY_RESTART   !== 'false',
  },

  public: {
    serverDescription: process.env.SERVER_DESCRIPTION ?? '',
    kofiUrl:           process.env.KOFI_URL            ?? '',
  },

  instances: parseInstances(),
}
