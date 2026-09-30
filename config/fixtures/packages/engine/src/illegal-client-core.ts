// FIXTURE — must be rejected by `engine-deps`: the engine knows nothing of the client.
import { connect } from '@crash/client-core';

export const leak = connect;
