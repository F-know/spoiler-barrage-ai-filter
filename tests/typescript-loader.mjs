// 用项目已有 TypeScript 编译器加载源码，测试无需新增运行时依赖。
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import ts from 'typescript';
import { parse, compileScript } from '@vue/compiler-sfc';

export async function resolve(specifier, context, nextResolve) {
  if (/\.(ts|vue)$/.test(context.parentURL ?? '') && specifier.startsWith('.') && !extname(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!/\.(ts|vue)$/.test(url)) return nextLoad(url, context);
  let source = await readFile(new URL(url), 'utf8');
  if (url.endsWith('.vue')) {
    const { descriptor } = parse(source, { filename: new URL(url).pathname });
    source = compileScript(descriptor, { id: url, inlineTemplate: true }).content;
  }
  return {
    format: 'module', shortCircuit: true,
    source: ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  };
}
