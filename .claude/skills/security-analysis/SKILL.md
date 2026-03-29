---
name: security-analysis
description: Comprehensive security vulnerability scanning and OWASP Top 10 compliance checking. Use when reviewing code for security issues, validating authentication/authorization, or ensuring security best practices.
auto_load: code-reviewer, backend-developer
priority: high
---

# Security Analysis Skill

## Quick Reference

Use this skill when:
- Reviewing code for security vulnerabilities
- Implementing authentication/authorization
- Validating input handling
- Checking for common security flaws
- Ensuring OWASP Top 10 compliance

## Metadata

**Category**: Security & Compliance
**Complexity**: Medium
**Time to Learn**: 30 minutes
**Prerequisites**: Understanding of web security basics

---

## Security Checklist (OWASP Top 10 2021)

### 1. Broken Access Control

**Check for**:
- Missing authorization checks on protected routes
- Insecure direct object references (IDOR)
- Privilege escalation vulnerabilities

**Example Vulnerable Code**:
```typescript
// ❌ BAD: No authorization check
router.delete('/api/users/:id', async (req, res) => {
  await deleteUser(req.params.id);
  res.status(204).send();
});
```

**Secure Alternative**:
```typescript
// ✅ GOOD: Verify user owns resource or is admin
router.delete('/api/users/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;

  // Check ownership or admin role
  if (userId !== id && req.user?.role !== 'admin') {
    throw new AppError('Forbidden', 403);
  }

  await deleteUser(id);
  res.status(204).send();
});
```

**Automated Scan**:
```bash
# Find routes without auth middleware
grep -rn "router\.\(get\|post\|put\|delete\|patch\)" src/server/routes/ | \
  grep -v "requireAuth\|isAuthenticated\|checkPermission" | \
  grep -v "public" > potential-unauth-routes.txt
```

---

### 2. Cryptographic Failures

**Check for**:
- Passwords stored in plain text
- Weak hashing algorithms (MD5, SHA1)
- Hardcoded secrets or API keys
- Insufficient bcrypt rounds (<10)

**Example Vulnerable Code**:
```typescript
// ❌ BAD: Weak hashing
import crypto from 'crypto';
const hash = crypto.createHash('md5').update(password).digest('hex');
```

**Secure Alternative**:
```typescript
// ✅ GOOD: Strong bcrypt hashing
import bcrypt from 'bcrypt';
const hash = await bcrypt.hash(password, 12); // 12+ rounds
```

**Automated Scan**:
```bash
# Find weak crypto usage
grep -rn "md5\|sha1\|createHash('sha1')" src/ && \
  echo "⚠️  Weak hashing detected"

# Find hardcoded secrets
grep -rn "api[_-]?key\s*=\s*['\"][a-zA-Z0-9]" src/ && \
  echo "⚠️  Hardcoded API key detected"

# Find bcrypt with low rounds
grep -rn "bcrypt\.hash.*,\s*[0-9])" src/ | grep -v "1[0-9]" && \
  echo "⚠️  Insufficient bcrypt rounds"
```

---

### 3. Injection Vulnerabilities

**Check for**:
- SQL injection (unparameterized queries)
- NoSQL injection (unvalidated MongoDB queries)
- Command injection (shell commands with user input)
- XSS (unescaped user content)

**Example Vulnerable Code**:
```typescript
// ❌ BAD: SQL injection
const query = `SELECT * FROM users WHERE email = '${userInput}'`;
db.query(query);

// ❌ BAD: Command injection
exec(`convert ${userFilename} output.jpg`);

// ❌ BAD: NoSQL injection
User.findOne({ email: req.body.email });
```

**Secure Alternatives**:
```typescript
// ✅ GOOD: Parameterized SQL query
const query = 'SELECT * FROM users WHERE email = $1';
db.query(query, [userInput]);

// ✅ GOOD: Validate filename, no shell execution
const safeFilename = path.basename(userFilename);
sharp(safeFilename).toFile('output.jpg');

// ✅ GOOD: Validate with Zod schema
const EmailSchema = z.object({ email: z.string().email() });
const { email } = EmailSchema.parse(req.body);
User.findOne({ email });
```

**Automated Scan**:
```bash
# Find potential SQL injection
grep -rn "query.*\${.*}" src/server/ && \
  echo "⚠️  Potential SQL injection (template literals)"

# Find command execution with user input
grep -rn "exec\|spawn\|execSync" src/ | \
  grep -v "// safe:" && \
  echo "⚠️  Potential command injection"
```

---

### 4. Insecure Design

**Check for**:
- Missing rate limiting on sensitive endpoints
- No CSRF protection
- Insecure session management
- Missing security headers

**Secure Patterns**:
```typescript
// ✅ Rate limiting
import rateLimit from 'express-rate-limit';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: 'Too many login attempts'
});

router.post('/api/auth/login', loginLimiter, loginHandler);

// ✅ Security headers
import helmet from 'helmet';
app.use(helmet());

// ✅ CSRF protection
import csrf from 'csurf';
app.use(csrf({ cookie: true }));
```

---

### 5. Security Misconfiguration

**Check for**:
- Debug mode enabled in production
- Default credentials
- Unnecessary features enabled
- Verbose error messages exposing internals

**Secure Configuration**:
```typescript
// ✅ Environment-specific error handling
app.use((err, req, res, next) => {
  const isDev = process.env.NODE_ENV === 'development';

  res.status(err.status || 500).json({
    error: err.message,
    // Only show stack in development
    ...(isDev && { stack: err.stack })
  });
});

// ✅ Disable unnecessary features
app.disable('x-powered-by');
```

**Automated Scan**:
```bash
# Find debug code
grep -rn "console\.log\|debugger" src/ && \
  echo "⚠️  Debug code in production"

# Find exposed secrets in error messages
grep -rn "throw.*password\|throw.*token\|throw.*secret" src/ && \
  echo "⚠️  Potential secret exposure in errors"
```

---

### 6. Vulnerable and Outdated Components

**Check for**:
- Outdated npm packages with known vulnerabilities
- Unused dependencies

**Automated Scan**:
```bash
# Check for vulnerabilities
npm audit --audit-level=moderate

# Check for outdated packages
npm outdated

# Check unused dependencies
npx depcheck
```

---

### 7. Identification and Authentication Failures

**Check for**:
- Weak password requirements
- No multi-factor authentication option
- Session fixation vulnerabilities
- Insufficient session timeout

**Secure Password Validation**:
```typescript
// ✅ Strong password requirements
const PasswordSchema = z.string()
  .min(12, 'Password must be at least 12 characters')
  .regex(/[A-Z]/, 'Must contain uppercase letter')
  .regex(/[a-z]/, 'Must contain lowercase letter')
  .regex(/[0-9]/, 'Must contain number')
  .regex(/[^A-Za-z0-9]/, 'Must contain special character');

// ✅ Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true, // HTTPS only
    httpOnly: true, // No JavaScript access
    maxAge: 15 * 60 * 1000, // 15 minutes
    sameSite: 'strict' // CSRF protection
  }
}));
```

---

### 8. Software and Data Integrity Failures

**Check for**:
- Unsigned/unverified packages
- No integrity checks on uploaded files
- Insecure deserialization

**Secure File Upload**:
```typescript
// ✅ Validate file type and size
import multer from 'multer';
import fileType from 'file-type';

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: async (req, file, cb) => {
    // Check MIME type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Invalid file type'));
    }
    cb(null, true);
  }
});

// Verify actual file type (not just extension)
router.post('/upload', upload.single('file'), async (req, res) => {
  const type = await fileType.fromBuffer(req.file.buffer);
  if (!type || !['jpg', 'png', 'gif'].includes(type.ext)) {
    throw new AppError('Invalid file type', 400);
  }
  // Process file...
});
```

---

### 9. Security Logging and Monitoring Failures

**Check for**:
- No audit logging for sensitive operations
- Missing security event monitoring
- No alerting for suspicious activity

**Secure Logging**:
```typescript
// ✅ Audit logging
import winston from 'winston';

const auditLogger = winston.createLogger({
  transports: [
    new winston.transports.File({ filename: 'audit.log' })
  ]
});

// Log security events
function auditLog(event: string, details: object) {
  auditLogger.info({
    timestamp: new Date().toISOString(),
    event,
    ...details,
    // Never log passwords or tokens!
    ...sanitizeSecrets(details)
  });
}

// Usage
router.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;

  try {
    const result = await login(email, password);
    auditLog('LOGIN_SUCCESS', { email, ip: req.ip });
    res.json(result);
  } catch (err) {
    auditLog('LOGIN_FAILURE', { email, ip: req.ip, reason: err.message });
    throw err;
  }
});
```

---

### 10. Server-Side Request Forgery (SSRF)

**Check for**:
- Unvalidated URL fetching
- Internal network access from user input
- Open redirects

**Secure URL Fetching**:
```typescript
// ✅ Validate and whitelist URLs
const ALLOWED_DOMAINS = ['api.example.com', 'cdn.example.com'];

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Block private IPs
    const privateIpRanges = ['127.', '10.', '172.16.', '192.168.', 'localhost'];
    if (privateIpRanges.some(range => parsed.hostname.startsWith(range))) {
      return false;
    }

    // Whitelist domains
    return ALLOWED_DOMAINS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

router.post('/fetch', async (req, res) => {
  const { url } = req.body;

  if (!validateUrl(url)) {
    throw new AppError('Invalid URL', 400);
  }

  const response = await fetch(url);
  res.json(await response.json());
});
```

---

## Automated Security Scan Script

Create `scripts/security-scan.sh`:

```bash
#!/bin/bash

echo "🔍 Running Security Scan..."
echo ""

# 1. NPM Audit
echo "1. Checking dependencies for vulnerabilities..."
npm audit --audit-level=moderate || echo "⚠️  Vulnerabilities found"
echo ""

# 2. Find hardcoded secrets
echo "2. Scanning for hardcoded secrets..."
grep -rn "password\s*=\s*['\"]" src/ --exclude-dir=node_modules && \
  echo "⚠️  Hardcoded passwords detected" || echo "✅ No hardcoded passwords"
echo ""

# 3. Find weak crypto
echo "3. Checking for weak cryptography..."
grep -rn "md5\|sha1" src/ --exclude-dir=node_modules && \
  echo "⚠️  Weak hashing detected" || echo "✅ Strong crypto only"
echo ""

# 4. Find SQL injection risks
echo "4. Checking for SQL injection risks..."
grep -rn "query.*\${" src/ --exclude-dir=node_modules && \
  echo "⚠️  Template literals in queries (injection risk)" || echo "✅ No injection risks"
echo ""

# 5. Check authentication
echo "5. Checking route authentication..."
grep -rn "router\.\(get\|post\|put\|delete\)" src/server/routes/ | \
  grep -v "requireAuth\|public" | wc -l | \
  xargs -I {} echo "⚠️  {} routes without auth middleware"
echo ""

# 6. Check for debug code
echo "6. Checking for debug code..."
grep -rn "console\.log\|debugger" src/ --exclude-dir=node_modules | wc -l | \
  xargs -I {} echo "⚠️  {} instances of debug code"
echo ""

echo "✅ Security scan complete"
```

Make executable:
```bash
chmod +x scripts/security-scan.sh
```

---

## Integration with Code Review

When the `code-reviewer` agent is invoked, this skill provides:

1. **Automated scans** via the security-scan script
2. **Manual checklist** for OWASP Top 10
3. **Remediation guidance** for each vulnerability type

---

## Common Vulnerabilities by File Type

### Frontend (React/TypeScript)

**XSS Vulnerabilities**:
```typescript
// ❌ BAD: dangerouslySetInnerHTML without sanitization
<div dangerouslySetInnerHTML={{ __html: userContent }} />

// ✅ GOOD: Sanitize with DOMPurify
import DOMPurify from 'dompurify';
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userContent) }} />
```

**Open Redirects**:
```typescript
// ❌ BAD: Unvalidated redirect
router.push(req.query.redirect);

// ✅ GOOD: Whitelist allowed paths
const ALLOWED_REDIRECTS = ['/dashboard', '/profile', '/settings'];
const redirect = req.query.redirect;
if (ALLOWED_REDIRECTS.includes(redirect)) {
  router.push(redirect);
}
```

### Backend (Node.js/Express)

**Authentication Bypass**:
```typescript
// ❌ BAD: Weak token validation
if (req.headers.authorization) {
  req.user = decodeToken(req.headers.authorization);
}

// ✅ GOOD: Verify signature
import jwt from 'jsonwebtoken';
const token = req.headers.authorization?.replace('Bearer ', '');
req.user = jwt.verify(token, process.env.JWT_SECRET);
```

---

## Security Tools Integration

### ESLint Security Plugin

```bash
npm install --save-dev eslint-plugin-security
```

```json
// .eslintrc.json
{
  "plugins": ["security"],
  "extends": ["plugin:security/recommended"]
}
```

### SAST Tools

```bash
# Snyk
npx snyk test

# CodeQL (GitHub)
# Configure in .github/workflows/codeql.yml
```

---

## Remember

- **Security is not optional** - Always validate inputs
- **Trust nothing from users** - Sanitize, validate, escape
- **Defense in depth** - Multiple layers of security
- **Principle of least privilege** - Minimal permissions
- **Audit everything** - Log security events
- **Keep dependencies updated** - Regular `npm audit`
- **HTTPS everywhere** - Encrypt in transit
- **Hash, don't encrypt** - For passwords, use bcrypt
