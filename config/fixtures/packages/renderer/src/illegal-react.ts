// FIXTURE — must be rejected by `react-stays-in-web`: the renderer is raw Canvas 2D.
import { useState } from 'react';

export const leak = useState;
