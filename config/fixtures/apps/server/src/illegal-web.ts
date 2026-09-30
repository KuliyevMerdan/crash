// FIXTURE — must be rejected by `nothing-imports-apps`: one app never composes the other.
import { mount } from '@crash/web';

export const leak = mount;
