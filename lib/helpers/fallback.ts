import { builders as b, type AST, type WalkerPath } from '@glimmer/syntax';
import { type JSUtils } from 'babel-plugin-ember-template-compilation';
import type ScopeStack from './scope-stack';
import { headNotInScope, unusedNameLike } from './scope-stack';
import { classify } from './string';

const FALLBACK_DETAILS_MESSAGE =
  'See https://github.com/tildeio/ember-this-fallback#embroider-compatibility for more details.';

export type AmbiguousPathExpression = AST.PathExpression & {
  head: AST.VarHead;
};

export type AmbiguousMustacheExpression = AST.MustacheStatement & {
  params: [];
  hash: AST.Hash & { pairs: [] };
  path: AmbiguousPathExpression;
};

export function needsFallback(
  expr: AST.Expression,
  scope: ScopeStack
): expr is AmbiguousPathExpression {
  return expr.type === 'PathExpression' && headNotInScope(expr.head, scope);
}

export function mustacheNeedsFallback(
  node: AST.MustacheStatement,
  scope: ScopeStack
): node is AmbiguousMustacheExpression {
  return (
    node.params.length === 0 &&
    node.hash.pairs.length === 0 &&
    needsFallback(node.path, scope)
  );
}

/**
 * Prefixes the `head` of the given `PathExpression` with `this`, making it a
 * `ThisHead`.
 *
 * For example:
 *
 * ```hbs
 * {{! before }}
 * {{global-helper property}}
 *
 * {{! after }}
 * {{global-helper this.property}}
 * ```
 *
 * or
 *
 * ```hbs
 * {{! before }}
 * {{property.value}}
 *
 * {{! after }}
 * {{this.property.value}}
 * ```
 */
export function expressionFallback(
  expr: AmbiguousPathExpression
): AST.PathExpression {
  const tail = `${expr.tail.length > 0 ? '.' : ''}${expr.tail.join('.')}`;
  const thisPath = `this.${expr.head.name}${tail}`;
  return b.path(thisPath, expr.loc);
}

/**
 * Performs `expressionFallback` only if `needsFallback` is `true`.
 */
export function maybeExpressionFallback(
  expr: AST.Expression,
  scope: ScopeStack
): AST.Expression {
  return needsFallback(expr, scope) ? expressionFallback(expr) : expr;
}

/**
 * Wraps a node with a `{{let}}` block that invokes the `tryLookupHelper` helper
 * to lookup the given ambiguous path heads as helpers at runtime. The results
 * of each lookup will be stored on a hash and available to the block with a
 * block param of the given name.
 *
 * This logic is contained within a `SubExpression` that can be used to replace
 * the ambiguous expression in the parent as shown below:
 *
 * ```hbs
 * {{! example }}
 * {{#let (hash property=(tryLookupHelper 'property')) as |maybeHelpers|}}
 *   {{! ... given node here ... }}
 * {{/let}}
 * ```
 */
export function wrapWithTryLookup(
  path: WalkerPath<AST.Statement>,
  node: AST.Statement,
  headsToLookup: Set<string>,
  blockParam: string,
  bindImport: JSUtils['bindImport']
): AST.BlockStatement {
  const tryLookupHelper = bindImport(
    'ember-this-fallback/try-lookup-helper',
    'default',
    path,
    { nameHint: 'try-lookup-helper' }
  );
  const lookupsHash = b.sexpr(
    b.path('hash'),
    undefined,
    b.hash(
      [...headsToLookup].map((headName) =>
        b.pair(headName, b.sexpr(tryLookupHelper, [b.string(headName)]))
      )
    )
  );

  return b.block(
    b.path('let'),
    [lookupsHash],
    null,
    b.blockItself([node], [blockParam]),
    null,
    node.loc
  );
}

/**
 * Provides a sub-expression that is useful within a node in a `{{let}}` block
 * that invokes the `tryLookupHelper`. If the property exists on the block param
 * with the given name, it will be invoked as a helper. If not, will use
 * `expressionFallback`.
 *
 * ```hbs
 * (if maybeHelpers.property (maybeHelpers.property) this.property)
 * ```
 */
export function helperOrExpressionFallback(
  blockParamName: string,
  expr: AmbiguousMustacheExpression
): AST.SubExpression {
  const headName = expr.path.head.name;
  const maybeHelper = `${blockParamName}.${headName}`;
  return b.sexpr(b.path('if'), [
    b.path(maybeHelper),
    b.sexpr(b.path(maybeHelper)),
    expressionFallback(expr.path),
  ]);
}

/**
 * Wraps an ambiguous expression with the `isComponent` helper to determine if
 * it is a component at runtime. If so, invokes it as a component. If not, wraps
 * the invocation with the `tryLookupHelper` helper to determine if it is a
 * helper at runtime and fallback to the `this` property if not.
 *
 * ```hbs
 * {{! before }}
 * {{property}}
 *
 * {{! after }}
 * {{#if (isComponent "property")}}
 *   <Property />
 * {{else}}
 *   {{#let (hash property=(tryLookupHelper "property")) as |maybeHelpers|}}
 *     {{(if maybeHelpers.property (maybeHelpers.property) this.property)}}
 *   {{/let}}
 * {{/if}}
 * ```
 */
export function ambiguousStatementFallback(
  expr: AmbiguousMustacheExpression,
  path: WalkerPath<AST.MustacheStatement>,
  bindImport: JSUtils['bindImport'],
  scope: ScopeStack
): AST.BlockStatement {
  const headName = expr.path.head.name;
  const isComponent = bindImport(
    'ember-this-fallback/is-component',
    'default',
    path,
    { nameHint: 'isComponent' }
  );

  const blockParamName = unusedNameLike('maybeHelpers', scope);
  const maybeHelperFallback = b.mustache(
    helperOrExpressionFallback(blockParamName, expr)
  );
  const tryLookup = wrapWithTryLookup(
    path,
    maybeHelperFallback,
    new Set([headName]),
    blockParamName,
    bindImport
  );

  return b.block(
    b.path('if'),
    [b.sexpr(isComponent, [b.string(headName)])],
    null,
    b.blockItself([b.element({ name: classify(headName), selfClosing: true })]),
    b.blockItself([tryLookup]),
    path.node.loc
  );
}

export function ambiguousAttrFallbackWarning(headName: string): string[] {
  const original = `{{${headName}}}`;

  return [
    `Found ambiguous mustache statement as attribute node value \`${original}\`.`,
    `Falling back to runtime dynamic resolution. You can avoid this fallback by:`,
    `- ${explicitHelperSuggestion(headName)}`,
    `- ${thisPropertySuggestion(headName)}`,
    FALLBACK_DETAILS_MESSAGE,
  ];
}

export function ambiguousStatementFallbackWarning(headName: string): string[] {
  return [
    `Found ambiguous mustache statement: \`{{${headName}}}\`.`,
    `Falling back to runtime dynamic resolution. You can avoid this fallback by:`,
    `- ${explicitHelperSuggestion(headName)}`,
    `- ${explicitComponentSuggestion(headName)}`,
    `- ${thisPropertySuggestion(headName)}`,
    FALLBACK_DETAILS_MESSAGE,
  ];
}

function explicitComponentSuggestion(name: string): string {
  const invocation = `<${classify(name)} />`;
  return `explicitly invoking a known component with angle-brackets: \`${invocation}\``;
}

function explicitHelperSuggestion(name: string): string {
  return `explicitly invoking a known helper with parens: \`{{(${name})}}\``;
}

function thisPropertySuggestion(name: string): string {
  return `prefacing a known property on \`this\` with \`this\`: \`{{this.${name}}}\``;
}
