import { createServer } from 'node:http'
import { createHttpHandler } from './http.js'
import { log, setLogLevel } from './log.js'
import { RoomManager } from './rooms.js'
import { attachWebSocket } from './ws.js'

// Збирає сервер з частин. Окремо від index.js, щоб тести могли підняти його на випадковому порту.
export function createApp(config) {
  setLogLevel(config.logLevel)
  const rooms = new RoomManager(config)
  rooms.createDefaults()
  const server = createServer(createHttpHandler({ config, rooms }))
  server.on('clientError', (err, socket) => socket.destroy(err)) // кривий HTTP від клієнта ≠ падіння
  const hub = attachWebSocket(server, { config, rooms })

  return {
    server,
    rooms,
    hub,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject) // EADDRINUSE тощо
        server.listen(config.port, config.host, () => {
          const { port } = server.address()
          log('info', 'server.listening', { host: config.host, port })
          resolve(port)
        })
      })
    },
    // Порядок: перестати приймати → попередити й закрити сокети → дописати логи матчів.
    async shutdown() {
      const stopped = new Promise((resolve) => server.close(resolve))
      server.closeIdleConnections()
      await hub.close()
      await rooms.closeAll()
      server.closeAllConnections()
      await stopped
    },
  }
}
