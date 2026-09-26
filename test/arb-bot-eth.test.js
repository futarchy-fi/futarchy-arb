const { expect } = require('chai');
const { candidateSizeLadder } = require('../scripts/arb-bot-eth');

describe('arb-bot-eth candidate size ladder', function () {
    it('tests every configured seed once before extending geometrically', function () {
        const sizes = candidateSizeLadder(
            [0.00005, 0.0001, 0.0002, 0.0005, 0.001], 2.5, 0.01
        );
        expect(sizes.slice(0, 5)).to.deep.equal([
            0.00005, 0.0001, 0.0002, 0.0005, 0.001,
        ]);
        expect(sizes.slice(5)).to.deep.equal([0.0025, 0.00625]);
    });

    it('sorts, deduplicates, and removes invalid or over-cap seeds', function () {
        expect(candidateSizeLadder([0.2, 0.05, 0.05, -1, NaN, 2], 2, 0.5))
            .to.deep.equal([0.05, 0.2, 0.4]);
    });

    it('rejects unsafe growth and an empty usable seed set', function () {
        expect(() => candidateSizeLadder([0.1], 1, 1)).to.throw('SIZE_GROWTH');
        expect(() => candidateSizeLadder([2], 2, 1)).to.throw('TEST_AMOUNTS_WETH');
    });
});
