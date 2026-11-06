pragma circom 2.1.6;

// Proofwork: prove "my committed score is at least `threshold`" without revealing the score.
// commitment = Poseidon(score_bps, salt, binding); binding ties the commitment to one scorecard
// (field element derived from the scorecard id). The company computes and anchors the commitment on Arc,
// so the employee cannot pick their own score; the employee holds (score, salt) and proves the inequality.
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

template ScoreThreshold() {
    signal input score;       // private: score in bps (0..65535)
    signal input salt;        // private: random field element
    signal input commitment;  // public
    signal input threshold;   // public: bps
    signal input binding;     // public: scorecard binding

    // range checks so the comparator is sound
    component sBits = Num2Bits(16);
    sBits.in <== score;
    component tBits = Num2Bits(16);
    tBits.in <== threshold;

    component h = Poseidon(3);
    h.inputs[0] <== score;
    h.inputs[1] <== salt;
    h.inputs[2] <== binding;
    h.out === commitment;

    component ge = GreaterEqThan(16);
    ge.in[0] <== score;
    ge.in[1] <== threshold;
    ge.out === 1;
}

component main {public [commitment, threshold, binding]} = ScoreThreshold();
