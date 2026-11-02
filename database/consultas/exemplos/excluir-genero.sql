-- Exemplo DELETE: somente na transação de teste validada que será revertida.
-- Bind: $id criado pelo exemplo. Finalidade: exclusão sem atingir preexistentes.
DELETE FROM generos WHERE id = $id RETURNING id, nome;
