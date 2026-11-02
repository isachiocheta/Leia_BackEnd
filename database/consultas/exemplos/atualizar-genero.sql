-- Exemplo UPDATE: somente na mesma transação de teste, com rollback ao final.
-- Bind: $id criado pelo exemplo, $nome. Finalidade: atualização pontual segura.
UPDATE generos SET nome = $nome, atualizado_em = CURRENT_TIMESTAMP
WHERE id = $id RETURNING id, nome;
