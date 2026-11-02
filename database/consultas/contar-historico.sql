-- Apoio ao requisito 6: total pessoal, incluindo ciclos encerrados.
-- Bind: $usuario, $ciclo (id ou NULL). Finalidade: paginação do histórico.
SELECT count(*) AS total FROM participacoes_leitura
WHERE usuario_id = $usuario AND ($ciclo::integer IS NULL OR ciclo_id = $ciclo);
