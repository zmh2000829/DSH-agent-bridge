/** Load the branded SessionId constructor from the running DSH installation. */

import { importFromDsh } from './dsh.js'

const { SessionId } = await importFromDsh('@deepseek-ai/dsh-session')
export { SessionId }
