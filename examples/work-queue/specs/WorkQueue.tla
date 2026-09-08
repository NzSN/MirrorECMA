------------------------------ MODULE WorkQueue ------------------------------
EXTENDS Integers, Sequences, FiniteSets

VARIABLES
  \* @type: Seq(Int);
  pending,
  \* @type: Int;
  inFlight,
  \* @type: Set(Int);
  completed,
  \* @type: Bool;
  failed,
  \* @type: { item: Int, step: Int };
  parameters,
  \* @type: Str;
  action_taken

Init ==
  /\ pending = <<>>
  /\ inFlight = 0
  /\ completed = {}
  /\ failed = FALSE
  /\ parameters = [item |-> 0, step |-> 0]
  /\ action_taken = "init"

Advance(label, item) ==
  /\ action_taken' = label
  /\ parameters' = [item |-> item, step |-> parameters.step + 1]

Enqueue(item) ==
  /\ item \in {1, 2}
  /\ pending' = IF (\E i \in DOMAIN pending: pending[i] = item)
                   \/ inFlight = item \/ item \in completed
                THEN pending ELSE Append(pending, item)
  /\ UNCHANGED <<inFlight, completed, failed>>
  /\ Advance("enqueue", item)

Start ==
  /\ inFlight = 0 /\ Len(pending) > 0
  /\ inFlight' = Head(pending)
  /\ pending' = Tail(pending)
  /\ failed' = FALSE
  /\ UNCHANGED completed
  /\ Advance("start", 0)

Fail ==
  /\ inFlight # 0 /\ ~failed
  /\ failed' = TRUE
  /\ UNCHANGED <<pending, inFlight, completed>>
  /\ Advance("fail", 0)

Retry ==
  /\ inFlight # 0 /\ failed
  /\ failed' = FALSE
  /\ UNCHANGED <<pending, inFlight, completed>>
  /\ Advance("retry", 0)

Complete ==
  /\ inFlight # 0 /\ ~failed
  /\ completed' = completed \cup {inFlight}
  /\ inFlight' = 0
  /\ UNCHANGED <<pending, failed>>
  /\ Advance("complete", 0)

Reset ==
  /\ pending' = <<>>
  /\ inFlight' = 0
  /\ completed' = {}
  /\ failed' = FALSE
  /\ Advance("reset", 0)

\* The application model permits every valid action, independent of the witness.
Next == (\E item \in {1, 2}: Enqueue(item))
        \/ Start \/ Fail \/ Retry \/ Complete \/ Reset

\* A deterministic regression path through the same application transitions.
WitnessNext ==
  \/ (parameters.step = 0 /\ Enqueue(1))
  \/ (parameters.step = 1 /\ Enqueue(1))
  \/ (parameters.step = 2 /\ Enqueue(2))
  \/ (parameters.step = 3 /\ Start)
  \/ (parameters.step = 4 /\ Enqueue(1))
  \/ (parameters.step = 5 /\ Fail)
  \/ (parameters.step = 6 /\ Retry)
  \/ (parameters.step = 7 /\ Complete)
  \/ (parameters.step = 8 /\ Enqueue(1))
  \/ (parameters.step = 9 /\ Start)
  \/ (parameters.step = 10 /\ Complete)
  \/ (parameters.step = 11 /\ Reset)
  \/ (parameters.step = 12 /\ Enqueue(2))
  \/ (parameters.step = 13 /\ Start)
  \/ (parameters.step = 14 /\ Complete)

TraceComplete == parameters.step < 15
View == <<pending, inFlight, completed, failed, parameters.step>>
Spec == Init /\ [][Next]_<<pending, inFlight, completed, failed, parameters, action_taken>>
=============================================================================
