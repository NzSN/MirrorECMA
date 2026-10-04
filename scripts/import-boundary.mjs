import ts from 'typescript';

// Package-role values are inert configuration. Inspect actual module dependency
// syntax, including declaration-only imports, rather than every string literal.
const gateSpecifier = value => typeof value === 'string' && /^(?:mirrorgate|mirrorgate-mirrorecma)(?:\/|$)/.test(value);
export function gateDependencies(text, filename = 'input.ts') {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const specifier = node => {
    if (!node) return;
    const value = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : undefined;
    if (gateSpecifier(value)) found.push(value);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier(node.argument.literal);
    if (ts.isExternalModuleReference(node)) specifier(node.expression);
    if (ts.isModuleDeclaration(node)) specifier(node.name);
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const requireCall = ts.isIdentifier(expression) && expression.text === 'require';
      const requireMember = ts.isPropertyAccessExpression(expression) &&
        (expression.name.text === 'require' || (ts.isIdentifier(expression.expression) && expression.expression.text === 'require' && expression.name.text === 'resolve'));
      if (expression.kind === ts.SyntaxKind.ImportKeyword || requireCall || requireMember) specifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
