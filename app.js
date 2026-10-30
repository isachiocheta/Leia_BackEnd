'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { carregarAmbiente } = require('./configuracao/ambiente');
const { rotaNaoEncontrada, tratarErros } = require('./intermediarios/erros');

const configuracao = carregarAmbiente();
const app = express();

app.set('env', configuracao.ambiente);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: configuracao.origemPermitida, credentials: true }));
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (requisicao, resposta) => {
  resposta.status(200).json({ aplicacao: 'Leia+', status: 'ok' });
});

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
