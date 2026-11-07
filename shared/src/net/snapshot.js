// Знімок світу як звичайні дані (без класів) — його кодують обидва кодеки, JSON і бінарний.

export const KIND_CODES = { ship: 1, bullet: 2, asteroid: 3, pickup: 4, explosion: 5 }
export const KINDS = Object.fromEntries(Object.entries(KIND_CODES).map(([k, v]) => [v, k]))
export const EFFECT_CODES = { shield: 0, rapid: 1, homing: 2 }
export const EFFECTS = Object.fromEntries(Object.entries(EFFECT_CODES).map(([k, v]) => [v, k]))

function entityState(e) {
  const base = { id: e.id, kind: e.kind, x: e.pos.x, y: e.pos.y }
  switch (e.kind) {
    case 'ship':
      return {
        ...base,
        angle: e.angle,
        vx: e.vel.x,
        vy: e.vel.y,
        hp: e.hp,
        solid: e.solid,
        thrust: e.thrust,
        cooldown: e.cooldown,
        shield: e.shield,
        rapid: e.rapid,
        homingShots: e.homingShots,
        respawnIn: e.respawnIn,
        score: e.score,
      }
    case 'bullet':
      return { ...base, homing: e.homing !== null, ownerId: e.ownerId, seq: e.seq }
    case 'asteroid':
      return {
        ...base,
        angle: e.angle,
        radius: e.radius,
        shape: e.shapeSeed % 3,
        homing: e.homing !== null,
      }
    case 'pickup':
      return { ...base, effect: e.pickup.effect }
    default:
      return base // explosion: частинки клієнт малює сам
  }
}

// tick — номер тіку сервера; ack — останній оброблений seq input-у ЦЬОГО клієнта.
export function buildSnapshot(world, tick, ack) {
  const entities = []
  for (const e of world) entities.push(entityState(e))
  return { type: 'snapshot', tick, ack, entities }
}
