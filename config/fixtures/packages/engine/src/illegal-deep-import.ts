// FIXTURE — must be rejected by `no-cross-package-deep-imports`.
import { schema } from '../../protocol/src/index';

export const leak = schema;
