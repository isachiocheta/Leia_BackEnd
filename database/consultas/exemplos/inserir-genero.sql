-- Exemplo INSERT: somente na transação de teste que será revertida.
-- Bind: $nome. Finalidade: demonstrar criação parametrizada sem dados sensíveis.
INSERT INTO generos (nome, criado_em, atualizado_em)
VALUES ($nome, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id, nome;
