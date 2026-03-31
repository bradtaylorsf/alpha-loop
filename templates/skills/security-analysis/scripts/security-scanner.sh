#!/bin/bash

##
# Security Scanner Script
# Comprehensive security scan for Node.js projects
#
# Usage:
#   ./security-scanner.sh
#   ./security-scanner.sh --strict  # Exit on any violation
##

STRICT_MODE=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --strict)
      STRICT_MODE=true
      shift
      ;;
  esac
done

echo "🔒 Running Security Scan..."
echo "Strict mode: $STRICT_MODE"
echo ""

VIOLATIONS=0

# ==============================================================================
# 1. NPM Audit
# ==============================================================================

echo "1️⃣  Checking dependencies for vulnerabilities..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if npm audit --audit-level=moderate 2>/dev/null; then
  echo "✅ No vulnerabilities found in dependencies"
else
  echo "⚠️  Vulnerabilities detected in dependencies"
  VIOLATIONS=$((VIOLATIONS + 1))
fi
echo ""

# ==============================================================================
# 2. Hardcoded Secrets
# ==============================================================================

echo "2️⃣  Scanning for hardcoded secrets..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check for hardcoded passwords
PASSWORDS=$(grep -rn "password\s*=\s*['\"]" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "// safe:" | wc -l)
if [ "$PASSWORDS" -gt 0 ]; then
  echo "⚠️  Found $PASSWORDS potential hardcoded password(s)"
  grep -rn "password\s*=\s*['\"]" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "// safe:"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "✅ No hardcoded passwords detected"
fi

# Check for hardcoded API keys
API_KEYS=$(grep -rn "api[_-]?key\s*=\s*['\"][a-zA-Z0-9]" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "// safe:" | wc -l)
if [ "$API_KEYS" -gt 0 ]; then
  echo "⚠️  Found $API_KEYS potential hardcoded API key(s)"
  grep -rn "api[_-]?key\s*=\s*['\"][a-zA-Z0-9]" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "// safe:"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "✅ No hardcoded API keys detected"
fi

echo ""

# ==============================================================================
# 3. Weak Cryptography
# ==============================================================================

echo "3️⃣  Checking for weak cryptography..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check for MD5/SHA1
WEAK_HASH=$(grep -rn "md5\|sha1\|createHash('sha1')" src/ --exclude-dir=node_modules 2>/dev/null | wc -l)
if [ "$WEAK_HASH" -gt 0 ]; then
  echo "⚠️  Found $WEAK_HASH use(s) of weak hashing (MD5/SHA1)"
  grep -rn "md5\|sha1" src/ --exclude-dir=node_modules 2>/dev/null
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "✅ No weak hashing detected"
fi

# Check for low bcrypt rounds
LOW_BCRYPT=$(grep -rn "bcrypt\.hash.*,\s*[0-9])" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "1[0-9]" | wc -l)
if [ "$LOW_BCRYPT" -gt 0 ]; then
  echo "⚠️  Found $LOW_BCRYPT bcrypt usage(s) with insufficient rounds (<10)"
  grep -rn "bcrypt\.hash.*,\s*[0-9])" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "1[0-9]"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "✅ Bcrypt rounds appear sufficient"
fi

echo ""

# ==============================================================================
# 4. SQL Injection Risks
# ==============================================================================

echo "4️⃣  Checking for SQL injection risks..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check for template literals in queries
SQL_INJECTION=$(grep -rn "query.*\${" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "// safe:" | wc -l)
if [ "$SQL_INJECTION" -gt 0 ]; then
  echo "⚠️  Found $SQL_INJECTION potential SQL injection(s) (template literals in queries)"
  grep -rn "query.*\${" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "// safe:"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "✅ No SQL injection risks detected"
fi

echo ""

# ==============================================================================
# 5. Command Injection Risks
# ==============================================================================

echo "5️⃣  Checking for command injection risks..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

CMD_INJECTION=$(grep -rn "exec\|spawn\|execSync" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "// safe:" | wc -l)
if [ "$CMD_INJECTION" -gt 0 ]; then
  echo "⚠️  Found $CMD_INJECTION use(s) of command execution (potential injection risk)"
  grep -rn "exec\|spawn\|execSync" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "// safe:"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "✅ No command injection risks detected"
fi

echo ""

# ==============================================================================
# 6. Missing Authentication
# ==============================================================================

echo "6️⃣  Checking for unauthenticated routes..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -d "src/server/routes" ]; then
  UNAUTH_ROUTES=$(grep -rn "router\.\(get\|post\|put\|delete\|patch\)" src/server/routes/ 2>/dev/null | grep -v "requireAuth\|isAuthenticated\|checkPermission\|public" | wc -l)
  if [ "$UNAUTH_ROUTES" -gt 0 ]; then
    echo "⚠️  Found $UNAUTH_ROUTES route(s) without authentication middleware"
    grep -rn "router\.\(get\|post\|put\|delete\|patch\)" src/server/routes/ 2>/dev/null | grep -v "requireAuth\|isAuthenticated\|checkPermission\|public"
    echo ""
    echo "💡 Review if these routes should be public or need auth middleware"
    VIOLATIONS=$((VIOLATIONS + 1))
  else
    echo "✅ All routes appear to have authentication checks"
  fi
else
  echo "ℹ️  No routes directory found (skipping)"
fi

echo ""

# ==============================================================================
# 7. Debug Code
# ==============================================================================

echo "7️⃣  Checking for debug code..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

DEBUG_COUNT=$(grep -rn "console\.log\|debugger" src/ --exclude-dir=node_modules 2>/dev/null | wc -l)
if [ "$DEBUG_COUNT" -gt 0 ]; then
  echo "⚠️  Found $DEBUG_COUNT instance(s) of debug code"
  echo "💡 Consider removing console.log and debugger statements in production"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "✅ No debug code detected"
fi

echo ""

# ==============================================================================
# 8. XSS Risks (React)
# ==============================================================================

echo "8️⃣  Checking for XSS risks..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

XSS_COUNT=$(grep -rn "dangerouslySetInnerHTML" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "DOMPurify\|sanitize" | wc -l)
if [ "$XSS_COUNT" -gt 0 ]; then
  echo "⚠️  Found $XSS_COUNT use(s) of dangerouslySetInnerHTML without sanitization"
  grep -rn "dangerouslySetInnerHTML" src/ --exclude-dir=node_modules 2>/dev/null | grep -v "DOMPurify\|sanitize"
  echo ""
  echo "💡 Ensure all HTML is sanitized with DOMPurify before rendering"
  VIOLATIONS=$((VIOLATIONS + 1))
else
  echo "✅ No XSS risks detected"
fi

echo ""

# ==============================================================================
# Summary
# ==============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$VIOLATIONS" -eq 0 ]; then
  echo "✅ Security scan passed! No violations found."
  echo ""
  exit 0
else
  echo "⚠️  Security scan found $VIOLATIONS violation(s)."
  echo "   Please review and address the issues above."
  echo ""

  if [ "$STRICT_MODE" = true ]; then
    echo "❌ Exiting with error due to --strict mode"
    exit 1
  else
    echo "ℹ️  Run with --strict to fail on violations"
    exit 0
  fi
fi
