// FIXTURE — must be accepted: a crowd of real clients is what the load test is made of.
import { CrashClient } from '@crash/client-core';
import { roundSnapshot } from '@crash/protocol';

export const crowd = [CrashClient, roundSnapshot];
