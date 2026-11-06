'use strict';

const express = require('express');
const { criarAutenticacao } = require('../autenticacao/rotas');
const { carregarConfiguracaoSessao } = require('../configuracao/sessao');
const { atenderAutenticacao } = require('../autenticacao/servico');

function inventariarRotas() {
  const montar = Symbol('prefixo da montagem');
  const routerOriginal = express.Router; const useOriginal = express.application.use;
  function registrarUso(alvo, usar, pilha) {
    return function (...args) {
      const inicio = pilha.call(this).length; const resultado = usar.apply(this, args);
      for (const camada of pilha.call(this).slice(inicio)) camada[montar] = typeof args[0] === 'string' ? args[0] : '';
      return resultado;
    };
  }
  const arquivo = require.resolve('../app'); const anterior = require.cache[arquivo]; let autenticacao;
  try {
    // Metadados de montagem em objetos construídos somente para a inspeção.
    // Não executa middleware, consultas, listen, bootstrap, migrations ou demo.
    express.Router = function (...args) {
      const roteador = routerOriginal(...args);
      roteador.use = registrarUso(roteador, roteador.use, function () { return this.stack; });
      return roteador;
    };
    express.application.use = registrarUso(express.application, useOriginal, function () { return this.router.stack; });
    delete require.cache[arquivo]; const app = require('../app');
    autenticacao = criarAutenticacao({
      configuracao: carregarConfiguracaoSessao({ NODE_ENV: 'test', SESSION_SECRET: 'Chave exclusiva da inspeção de rotas sem sessões reais', SESSION_COOKIE_SECURE: 'false' }),
      pool: { query() { throw new Error('Inspeção não pode consultar o banco.'); } },
      obterUsuario() { throw new Error('Inspeção não pode autenticar usuários.'); },
    });
    const rotas = [];
    function visitar(pilha, prefixo = '') {
      for (const camada of pilha) {
        if (camada.route) {
          if (typeof camada.route.path !== 'string') throw new Error('Rota não literal exige revisão do contrato.');
          const caminho = (prefixo + (camada.route.path === '/' ? '' : camada.route.path)).replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
          for (const [metodo, ativo] of Object.entries(camada.route.methods)) if (ativo) rotas.push(`${metodo.toUpperCase()} ${caminho}`);
        } else if (camada.handle === atenderAutenticacao) visitar(autenticacao.roteador.stack, prefixo + camada[montar]);
        else if (camada.handle?.stack) visitar(camada.handle.stack, prefixo + (camada[montar] || ''));
      }
    }
    visitar(app.router.stack);
    if (new Set(rotas).size !== rotas.length) throw new Error('Operação duplicada nas rotas.');
    return rotas.sort();
  } finally {
    express.Router = routerOriginal; express.application.use = useOriginal;
    if (anterior) require.cache[arquivo] = anterior; else delete require.cache[arquivo];
    if (autenticacao) autenticacao.encerrar();
  }
}

module.exports = { inventariarRotas };
