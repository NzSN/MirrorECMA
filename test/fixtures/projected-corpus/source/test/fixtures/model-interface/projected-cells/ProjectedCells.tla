-------------------------- MODULE ProjectedCells --------------------------
EXTENDS Integers, FiniteSets

VARIABLES cells, action_taken, parameters

Indices == 0..1
Keys == {"seen", "updates"}
EmptyWeights == [key \in Keys |-> 0]
EmptyCell == [count |-> 0, labels |-> {"fresh"}, weights |-> EmptyWeights]

Init ==
  /\ cells = [index \in Indices |-> EmptyCell]
  /\ action_taken = "init"
  /\ parameters = [index |-> 0, delta |-> 0,
                     labels |-> {"fresh"}, weights |-> EmptyWeights]

Update(index, delta, labels, weights) ==
  /\ index \in Indices
  /\ delta \in {2, 3}
  /\ labels \subseteq {"blue", "hot", "fresh"}
  /\ weights \in [Keys -> 0..3]
  /\ cells' = [cells EXCEPT ![index] =
       [count |-> @.count + delta, labels |-> labels, weights |-> weights]]
  /\ action_taken' = "update"
  /\ parameters' = [index |-> index, delta |-> delta,
                      labels |-> labels, weights |-> weights]

Next == \E index \in Indices, delta \in {2, 3},
             labels \in SUBSET {"blue", "hot", "fresh"}, weights \in [Keys -> 0..3]:
          Update(index, delta, labels, weights)

Inv == \A index \in Indices: cells[index].count >= 0
=============================================================================
