import Fastify from 'fastify'
import fastifyCookie   from '@fastify/cookie'
import fastifyJwt      from '@fastify/jwt'
import fastifyCors     from '@fastify/cors'
import fastifyHelmet   from '@fastify/helmet'
import rateLimit       from '@fastify/rate-limit'
import fastifyStatic   from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import path from 'path'
import fs   from 'fs'
import { config } from './config'
import { db, runMigrations } from './db'
import { publicRoutes }    from './routes/public'
import { authRoutes }      from './routes/auth'
import { dashboardRoutes } from './routes/dashboard'
import { adminRoutes }     from './routes/admin'
import { presetsRoutes }   from './routes/presets'
import { startLogWatchers } from './services/logWatcher'
import { hashPassword }     from './routes/auth'

// trustProxy: false by default — the panel is exposed directly by Docker
// (no proxy in front unless the operator adds one, cf. README). With
// trustProxy:true unconditionally, anyone could forge X-Forwarded-For to
// get a fresh rate-limit bucket on every login attempt. TRUST_PROXY_HOPS=1
// when there's exactly one reverse proxy (Caddy/Nginx) terminating in front.
const trustProxyHops = process.env.TRUST_PROXY_HOPS ? parseInt(process.env.TRUST_PROXY_HOPS, 10) : false
const app = Fastify({ logger: { level: 'info' }, trustProxy: trustProxyHops })

async function main(): Promise<void> {
  // ── Startup security checks ────────────────────────────────────
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me' || process.env.JWT_SECRET === 'change-me-in-production') {
    console.error('[FATAL] JWT_SECRET must be set to a strong random value in .env')
    console.error('[FATAL] Generate one with: openssl rand -hex 32')
    process.exit(1)
  }
  if (process.env.JWT_SECRET.length < 32) {
    console.error('[FATAL] JWT_SECRET is too short — minimum 32 characters')
    console.error('[FATAL] Generate one with: openssl rand -hex 32')
    process.exit(1)
  }
  if (!process.env.POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD === 'beammp') {
    console.warn('[WARN]  POSTGRES_PASSWORD is using the default value — change it in production')
  }
  if (!process.env.ALLOWED_ORIGIN) {
    console.warn('[WARN]  ALLOWED_ORIGIN is not set — same-origin mode active.')
    console.warn('[WARN]  If your frontend is served from a different domain, set ALLOWED_ORIGIN.')
  }
  if (process.env.SUPERADMIN_PASSWORD && process.env.SUPERADMIN_PASSWORD === 'changeme123') {
    console.warn('[WARN]  SUPERADMIN_PASSWORD is using the default value — change it before first launch')
  }

  // ── Plugins (order matters) ────────────────────────────────────

  // Cookies must be registered before JWT so jwtVerify() can read them
  await app.register(fastifyCookie)

  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: 'beammp_token', signed: false },
  })

  // Rate limiting — non global : s'applique uniquement aux routes qui déclarent
  // config.rateLimit (ex: login). Les autres routes ne sont pas limitées.
  await app.register(rateLimit, {
    global:       false,
    keyGenerator: (req) => req.ip, // IP réelle grâce à trustProxy
  })

  // Security headers
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc:              ["'self'"],
        // No 'unsafe-inline' here — the Vite build emits a single external
        // <script src> (verified in frontend/dist/index.html), never an
        // inline <script>. styleSrc keeps it: React's style={{...}} props
        // compile to real inline style="" attributes, and per-element
        // nonces aren't practical for dynamically computed styles.
        scriptSrc:               ["'self'"],
        styleSrc:                ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc:                  ["'self'", 'data:', 'blob:'],
        connectSrc:              ["'self'"],
        fontSrc:                 ["'self'", 'https://fonts.gstatic.com'],
        frameSrc:                ["'none'"],
        objectSrc:               ["'none'"],
        // Désactivé : upgrade-insecure-requests casse l'accès HTTP direct
        upgradeInsecureRequests: null,
      },
    },
  })

  // CORS — restricted to configured origin (or disabled if not set)
  if (config.allowedOrigin) {
    await app.register(fastifyCors, {
      origin:      config.allowedOrigin,
      credentials: true,
      methods:     ['GET', 'POST', 'PATCH', 'DELETE'],
    })
  } else {
    // Same-origin only (frontend served by same server — no CORS needed)
    await app.register(fastifyCors, { origin: false })
  }

  await app.register(fastifyMultipart, { limits: { fileSize: 500 * 1024 * 1024 } })

  // ── Frontend SPA (registered first so sendFile() points to this root) ───
  const frontendPath = path.join(__dirname, '..', 'public')
  if (fs.existsSync(frontendPath)) {
    await app.register(fastifyStatic, {
      root:   frontendPath,
      prefix: '/',
      // decorateReply defaults to true → reply.sendFile() available
    })
    app.setNotFoundHandler((_, reply) => reply.code(200).sendFile('index.html'))
  }

  // ── Images (always local Docker volume) ───────────────────────
  if (!fs.existsSync(config.localImagesPath)) {
    fs.mkdirSync(config.localImagesPath, { recursive: true })
  }
  await app.register(fastifyStatic, {
    root:          config.localImagesPath,
    prefix:        '/images/',
    decorateReply: false, // second registration must not re-decorate
  })

  // ── Version header on every API response ──────────────────────
  // Keep in sync with CHANGELOG.md's latest entry.
  const PANEL_VERSION = '1.2.0'
  app.addHook('onSend', async (_, reply) => {
    reply.header('X-BeamMP-Panel-Version', PANEL_VERSION)
  })

  // ── Routes ────────────────────────────────────────────────────
  await app.register(publicRoutes)
  await app.register(authRoutes)
  await app.register(dashboardRoutes)
  await app.register(adminRoutes)
  await app.register(presetsRoutes)

  // ── Init ──────────────────────────────────────────────────────
  await runMigrations()
  await createInitialSuperAdmin()
  startLogWatchers()

  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[app] Running on http://0.0.0.0:${config.port}`)
  console.log(`[app] Instances: ${config.instances.map(i => i.id).join(', ')}`)
  console.log(`[app] Images path: ${config.localImagesPath}`)
}

async function createInitialSuperAdmin(): Promise<void> {
  const username = process.env.SUPERADMIN_USERNAME
  const password = process.env.SUPERADMIN_PASSWORD
  if (!username || !password) return
  const count = await db.query('SELECT COUNT(*) FROM users')
  if (parseInt(count.rows[0].count) > 0) return
  if (password.length < 8) {
    console.warn('[setup] SUPERADMIN_PASSWORD trop court (min 8 chars) — ignoré')
    return
  }
  await db.query(
    `INSERT INTO users (username, password, role) VALUES ($1, $2, 'superadmin')`,
    [username, await hashPassword(password)]
  )
  console.log(`[setup] SuperAdmin "${username}" créé`)
}

main().catch((err) => { console.error(err); process.exit(1) })
