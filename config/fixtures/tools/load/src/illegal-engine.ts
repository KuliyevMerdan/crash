// FIXTURE — must be rejected by `load-deps`: the load test holds its crowd to the server's own
// account over the wire, never to an engine it runs beside it — or it would test itself.
import { auditMoney } from '@crash/engine';

export const peek = auditMoney;
