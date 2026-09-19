// 用项目已有 TypeScript 编译器加载源码，测试无需新增运行时依赖。
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && !extname(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return {
    format: 'module', shortCircuit: true,
    source: ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  };
}
