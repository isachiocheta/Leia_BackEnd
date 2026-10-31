'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');

const LIMITE_CORPO = 100 * 1024;

function configurarHttp(app, configuracao) {
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(helmet());
  app.use((requisicao, resposta, proximo) => {
    resposta.vary('Origin');
    resposta.set('Cache-Control', 'no-store');
    proximo();
  });
  app.use(cors({
    origin(origem, retornar) {
      retornar(null, origem === configuracao.origemPermitida);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    optionsSuccessStatus: 204,
    preflightContinue: false,
  }));
  app.use((requisicao, resposta, proximo) => {
    if (Number(requisicao.get('Content-Length')) > LIMITE_CORPO) {
      return proximo(new ErroAplicacao('PAYLOAD_TOO_LARGE'));
    }
    return proximo();
  });
  app.use(express.json({
    limit: LIMITE_CORPO,
    strict: true,
    type: ['application/json', 'application/*+json'],
  }));
}

module.exports = { configurarHttp };
