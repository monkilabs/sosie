// One Sosie starting on a store at the same moment as others: it opens the store, draws fakes from a
// small pool so that the Sosies compete for them, and prints what it got. Runs the built core.
import { Store } from '../dist/store.js'

const store = Store.open(process.argv[2])
const values = Array.from({ length: 30 }, (_, i) => `v${i}`).sort(() => Math.random() - 0.5)
const got = {}
for (const value of values) {
  got[value] = store.fake('d', value, { unique: true, scannable: false }, (seed, attempt) => `c${(seed[0] + attempt) % 40}`)
}
store.close()
process.stdout.write(JSON.stringify(got))
