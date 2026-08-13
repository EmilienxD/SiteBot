/**
 * The Phase 8 production audit, re-exported under the name the doctor command
 * thinks in.
 *
 * The implementations live in `index.ts` because they shipped with Phase 8,
 * before the rest of the CLI existed and before `commands/` was a place to put
 * them. Moving them now would churn the Phase 8 tests for no behavioural gain,
 * so the command imports this alias instead.
 */

export {
  productionDoctor,
  findInlineSecrets,
  type DoctorReport,
  type ProductionCheck,
} from './index.js'
