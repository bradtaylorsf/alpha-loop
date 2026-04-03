# Test Failure Output

```
FAIL tests/services/order.service.test.ts

  ● Test suite failed to run

    Cannot find module './utils.js' from 'src/services/order.service.ts'

    Require stack:
    - src/services/order.service.ts
    - tests/services/order.service.test.ts

      1 | import { formatCurrency, formatDate } from './utils.js';
        | ^
      2 | import { prisma } from '../lib/prisma.js';

      at Resolver.resolveModule (node_modules/jest-resolve/build/resolver.js:427:17)
```

## Directory Structure

```
src/
  services/
    order.service.ts       <-- file with the bad import
  lib/
    utils.js               <-- the actual file location
  utils.js                 <-- does NOT exist
```
