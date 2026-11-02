-- Apoio ao requisito 4 e ao dashboard: total de obras com o mesmo HAVING da lista.
-- Bind: $minimo (inteiro >=1). Finalidade: informar total mesmo quando há limite.
SELECT COUNT(*)::integer AS total FROM (
  SELECT l.id FROM livros l JOIN ciclos_leitura c ON c.livro_id = l.id
  GROUP BY l.id HAVING COUNT(c.id) >= $minimo
) AS obras;
