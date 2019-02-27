'use strict';

const CHOOSABLE_TARGETS = new Set(['normal', 'any', 'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe']);

/**@type {BattleScriptsData} */
let BattleScripts = {
	gen: 7,
	/**
	 * runMove is the "outside" move caller. It handles deducting PP,
	 * flinching, full paralysis, etc. All the stuff up to and including
	 * the "POKEMON used MOVE" message.
	 *
	 * For details of the difference between runMove and useMove, see
	 * useMove's info.
	 *
	 * externalMove skips LockMove and PP deduction, mostly for use by
	 * Dancer.
	 */
	runMove(moveOrMoveName, pokemon, targetLoc, sourceEffect, zMove, externalMove) {
		let target = this.getTarget(pokemon, zMove || moveOrMoveName, targetLoc);
		let baseMove = this.getActiveMove(moveOrMoveName);
		const pranksterBoosted = baseMove.pranksterBoosted;
		if (!sourceEffect && baseMove.id !== 'struggle' && !zMove) {
			let changedMove = this.runEvent('OverrideAction', pokemon, target, baseMove);
			if (changedMove && changedMove !== true) {
				baseMove = this.getActiveMove(changedMove);
				if (pranksterBoosted) baseMove.pranksterBoosted = pranksterBoosted;
				target = this.resolveTarget(pokemon, baseMove);
			}
		}
		let move = zMove ? this.getActiveZMove(baseMove, pokemon) : baseMove;

		move.isExternal = externalMove;

		this.setActiveMove(move, pokemon, target);

		/* if (pokemon.moveThisTurn) {
			// THIS IS PURELY A SANITY CHECK
			// DO NOT TAKE ADVANTAGE OF THIS TO PREVENT A POKEMON FROM MOVING;
			// USE this.cancelMove INSTEAD
			this.debug('' + pokemon.id + ' INCONSISTENT STATE, ALREADY MOVED: ' + pokemon.moveThisTurn);
			this.clearActiveMove(true);
			return;
		} */
		let willTryMove = this.runEvent('BeforeMove', pokemon, target, move);
		if (!willTryMove) {
			this.runEvent('MoveAborted', pokemon, target, move);
			this.clearActiveMove(true);
			// The event 'BeforeMove' could have returned false or null
			// false indicates that this counts as a move failing for the purpose of calculating Stomping Tantrum's base power
			// null indicates the opposite, as the Pokemon didn't have an option to choose anything
			pokemon.moveThisTurnResult = willTryMove;
			return;
		}
		if (move.beforeMoveCallback) {
			if (move.beforeMoveCallback.call(this, pokemon, target, move)) {
				this.clearActiveMove(true);
				pokemon.moveThisTurnResult = false;
				return;
			}
		}
		pokemon.lastDamage = 0;
		let lockedMove;
		if (!externalMove) {
			lockedMove = this.runEvent('LockMove', pokemon);
			if (lockedMove === true) lockedMove = false;
			if (!lockedMove) {
				if (!pokemon.deductPP(baseMove, null, target) && (move.id !== 'struggle')) {
					this.add('cant', pokemon, 'nopp', move);
					let gameConsole = [null, 'Game Boy', 'Game Boy', 'Game Boy Advance', 'DS', 'DS'][this.gen] || '3DS';
					this.add('-hint', "This is not a bug, this is really how it works on the " + gameConsole + "; try it yourself if you don't believe us.");
					this.clearActiveMove(true);
					pokemon.moveThisTurnResult = false;
					return;
				}
			} else {
				sourceEffect = this.getEffect('lockedmove');
			}
			pokemon.moveUsed(move, targetLoc);
		}

		// Dancer Petal Dance hack
		// TODO: implement properly
		let noLock = externalMove && !pokemon.volatiles.lockedmove;

		if (zMove) {
			if (pokemon.illusion) {
				this.singleEvent('End', this.getAbility('Illusion'), pokemon.abilityData, pokemon);
			}
			this.add('-zpower', pokemon);
			pokemon.side.zMoveUsed = true;
		}
		let moveDidSomething = this.useMove(baseMove, pokemon, target, sourceEffect, zMove);
		if (this.activeMove) move = this.activeMove;
		this.singleEvent('AfterMove', move, null, pokemon, target, move);
		this.runEvent('AfterMove', pokemon, target, move);

		// Dancer's activation order is completely different from any other event, so it's handled separately
		if (move.flags['dance'] && moveDidSomething && !move.isExternal) {
			let dancers = [];
			for (const side of this.sides) {
				for (const currentPoke of side.active) {
					if (!currentPoke || !currentPoke.hp || pokemon === currentPoke) continue;
					if (currentPoke.hasAbility('dancer') && !currentPoke.isSemiInvulnerable()) {
						dancers.push(currentPoke);
					}
				}
			}
			// Dancer activates in order of lowest speed stat to highest
			// Ties go to whichever Pokemon has had the ability for the least amount of time
			dancers.sort(function (a, b) { return -(b.stats['spe'] - a.stats['spe']) || b.abilityOrder - a.abilityOrder; });
			for (const dancer of dancers) {
				if (this.faintMessages()) break;
				this.add('-activate', dancer, 'ability: Dancer');
				this.runMove(move.id, dancer, 0, this.getAbility('dancer'), undefined, true);
				// Using a Dancer move is enough to spoil Fake Out etc.
				dancer.activeTurns++;
			}
		}
		if (noLock && pokemon.volatiles.lockedmove) delete pokemon.volatiles.lockedmove;
	},
	/**
	 * useMove is the "inside" move caller. It handles effects of the
	 * move itself, but not the idea of using the move.
	 *
	 * Most caller effects, like Sleep Talk, Nature Power, Magic Bounce,
	 * etc use useMove.
	 *
	 * The only ones that use runMove are Instruct, Pursuit, and
	 * Dancer.
	 */
	useMove(move, pokemon, target, sourceEffect, zMove) {
		pokemon.moveThisTurnResult = undefined;
		/** @type {boolean? | undefined} */ // Typescript bug
		let oldMoveResult = pokemon.moveThisTurnResult;
		let moveResult = this.useMoveInner(move, pokemon, target, sourceEffect, zMove);
		if (oldMoveResult === pokemon.moveThisTurnResult) pokemon.moveThisTurnResult = moveResult;
		return moveResult;
	},
	useMoveInner(moveOrMoveName, pokemon, target, sourceEffect, zMove) {
		if (!sourceEffect && this.effect.id) sourceEffect = this.effect;
		if (sourceEffect && sourceEffect.id === 'instruct') sourceEffect = null;

		let move = this.getActiveMove(moveOrMoveName);
		if (move.id === 'weatherball' && zMove) {
			// Z-Weather Ball only changes types if it's used directly,
			// not if it's called by Z-Sleep Talk or something.
			this.singleEvent('ModifyMove', move, null, pokemon, target, move, move);
			if (move.type !== 'Normal') sourceEffect = move;
		}
		if (zMove || (move.category !== 'Status' && sourceEffect && sourceEffect.isZ)) {
			move = this.getActiveZMove(move, pokemon);
		}

		if (this.activeMove) {
			move.priority = this.activeMove.priority;
			if (!move.hasBounced) move.pranksterBoosted = this.activeMove.pranksterBoosted;
		}
		let baseTarget = move.target;
		if (target === undefined) target = this.resolveTarget(pokemon, move);
		if (move.target === 'self' || move.target === 'allies') {
			target = pokemon;
		}
		if (sourceEffect) {
			move.sourceEffect = sourceEffect.id;
			move.ignoreAbility = false;
		}
		let moveResult = false;

		this.setActiveMove(move, pokemon, target);

		this.singleEvent('ModifyMove', move, null, pokemon, target, move, move);
		if (baseTarget !== move.target) {
			// Target changed in ModifyMove, so we must adjust it here
			// Adjust before the next event so the correct target is passed to the
			// event
			target = this.resolveTarget(pokemon, move);
		}
		move = this.runEvent('ModifyMove', pokemon, target, move, move);
		if (baseTarget !== move.target) {
			// Adjust again
			target = this.resolveTarget(pokemon, move);
		}
		if (!move || pokemon.fainted) {
			return false;
		}

		let attrs = '';

		let movename = move.name;
		if (move.id === 'hiddenpower') movename = 'Hidden Power';
		if (sourceEffect) attrs += '|[from]' + this.getEffect(sourceEffect);
		if (zMove && move.isZ === true) {
			attrs = '|[anim]' + movename + attrs;
			movename = 'Z-' + movename;
		}
		this.addMove('move', pokemon, movename, target + attrs);

		if (zMove) this.runZPower(move, pokemon);

		if (!target) {
			this.attrLastMove('[notarget]');
			this.add(this.gen >= 5 ? '-fail' : '-notarget', pokemon);
			if (move.target === 'normal') pokemon.isStaleCon = 0;
			return false;
		}

		let targets = pokemon.getMoveTargets(move, target);

		if (!sourceEffect || sourceEffect.id === 'pursuit') {
			let extraPP = 0;
			for (const source of targets) {
				let ppDrop = this.runEvent('DeductPP', source, pokemon, move);
				if (ppDrop !== true) {
					extraPP += ppDrop || 0;
				}
			}
			if (extraPP > 0) {
				pokemon.deductPP(move, extraPP);
			}
		}

		if (!this.singleEvent('TryMove', move, null, pokemon, target, move) ||
			!this.runEvent('TryMove', pokemon, target, move)) {
			move.mindBlownRecoil = false;
			return false;
		}

		this.singleEvent('UseMoveMessage', move, null, pokemon, target, move);

		if (move.ignoreImmunity === undefined) {
			move.ignoreImmunity = (move.category === 'Status');
		}

		if (move.selfdestruct === 'always') {
			this.faint(pokemon, pokemon, move);
		}

		/** @type {number | false | undefined | ''} */
		let damage = false;
		if (move.target === 'all' || move.target === 'foeSide' || move.target === 'allySide' || move.target === 'allyTeam') {
			damage = this.tryMoveHit(target, pokemon, move);
			if (damage === this.NOT_FAILURE) pokemon.moveThisTurnResult = null;
			if (damage || damage === 0 || damage === undefined) moveResult = true;
		} else {
			moveResult = this.trySpreadMoveHit(targets, pokemon, move);
		}
		if (move.selfBoost && moveResult) this.moveHit(pokemon, pokemon, move, move.selfBoost, false, true);
		if (!pokemon.hp) {
			this.faint(pokemon, pokemon, move);
		}

		if (!moveResult) {
			this.singleEvent('MoveFail', move, null, target, pokemon, move);
			return false;
		}

		return true;
	},
	trySpreadMoveHit(targets, pokemon, move) {
		if (!targets.length) {
			this.attrLastMove('[notarget]');
			this.add(this.gen >= 5 ? '-fail' : '-notarget', pokemon);
			return false;
		}
		if (targets.length > 1) move.spreadHit = true;

		/** @type {((targets: Pokemon[], pokemon: Pokemon, move: ActiveMove) => (number | boolean | "" | undefined)[] | undefined)[]} */
		let moveSteps = [
			// 0. check for semi invulnerability
			this.tryImmunityEvent,

			// 1. check for type immunity (this is step 2 in gen 7+)
			this.typeImmunity,

			// 2. run the 'TryHit' event (Protect, Magic Bounce, Volt Absorb, etc.) (this is step 1 in gen 7)
			this.tryHitEvent,

			// 3. check for powder immunity
			this.powderImmunity,

			// 4. check for prankster immunity
			this.pranksterImmunity,

			// 5. check accuracy
			this.accuracy,

			// 6. break protection effects
			this.breakProtect,

			// 7. steal positive boosts (Spectral Thief)
			this.stealBoosts,

			// 8. loop that processes each hit of the move (has its own steps per iteration)
			this.moveHitLoop,

			// 9. effects that run after secondary effects, such as Color Change
			this.afterMoveSecondaryEvent,
		];
		if (this.gen >= 7) {
			// Swap step 1 with step 2
			[moveSteps[1], moveSteps[2]] = [moveSteps[2], moveSteps[1]];
		}

		this.setActiveMove(move, pokemon, targets[0]);
		move.zBrokeProtect = false;

		let hitResult = this.singleEvent('PrepareHit', move, {}, targets[0], pokemon, move);
		if (!hitResult) {
			if (hitResult === false) {
				this.add('-fail', pokemon);
				this.attrLastMove('[still]');
			}
			return false;
		}
		this.runEvent('PrepareHit', pokemon, targets[0], move);

		if (!this.singleEvent('Try', move, null, pokemon, targets[0], move)) {
			return false;
		}

		let finalResult;
		let hitResults;
		for (const step of moveSteps) {
			hitResults = step.call(this, targets, pokemon, move);
			if (!hitResults) continue;
			for (let i = 0; i < targets.length; i++) {
				if (!hitResults[i]) {
					// hit resolved for this target.
					// remove target and corresponding hitResults entry from their respective arrays
					targets.splice(i, 1);
					let targetResult = hitResults.splice(i, 1)[0];
					i--;
					// store failure/NOT_FAILURE in finalResult, with the following priority:
					// truthy/number > false > '' > undefined
					if (targetResult || targetResult === 0) {
						finalResult = targetResult;
					} else if (finalResult !== false || targetResult !== this.NOT_FAILURE) {
						finalResult = targetResult;
					}
				}
			}
		}

		let moveResult = !!targets.length;
		if (!moveResult && finalResult === this.NOT_FAILURE) pokemon.moveThisTurnResult = null;
		if (move.spreadHit) this.attrLastMove('[spread] ' + targets.join(','));
		return moveResult;
	},
	tryImmunityEvent(targets, pokemon, move) {
		let hitResults = this.runEvent('TryImmunity', targets, pokemon, move);
		targets.forEach((target, index) => {
			if (hitResults[index] === false) {
				if (!move.spreadHit) this.attrLastMove('[miss]');
				this.add('-miss', pokemon, target);
			} else {
				hitResults[index] = false;
			}
		});
		return hitResults;
	},
	typeImmunity(targets, pokemon, move) {
		if (move.ignoreImmunity === undefined) {
			move.ignoreImmunity = (move.category === 'Status');
		}

		let hitResults = [];
		for (let i = 0; i < targets.length; i++) {
			hitResults[i] = (move.ignoreImmunity && (move.ignoreImmunity === true || move.ignoreImmunity[move.type])) || targets[i].runImmunity(move.type, true);
		}

		return hitResults;
	},
	tryHitEvent(targets, pokemon, move) {
		let hitResults = this.runEvent('TryHit', targets, pokemon, move);
		if (!hitResults.includes(true) && hitResults.includes(false)) {
			this.add('-fail', pokemon);
			this.attrLastMove('[still]');
		}
		for (let i = 0; i < targets.length; i++) {
			if (hitResults[i] !== this.NOT_FAILURE) hitResults[i] = false;
		}
		return hitResults;
	},
	powderImmunity(targets, pokemon, move) {
		let hitResults = [];
		if (!move.flags['powder']) {
			for (let i = 0; i < targets.length; i++) {
				hitResults[i] = true;
			}
			return hitResults;
		}
		for (let [i, target] of targets.entries()) {
			if (target !== pokemon && !this.getImmunity('powder', target)) {
				this.debug('natural powder immunity');
				this.add('-immune', target);
				hitResults[i] = false;
			} else {
				hitResults[i] = true;
			}
		}
		return hitResults;
	},
	pranksterImmunity(targets, pokemon, move) {
		let hitResults = [];
		if (this.gen < 7 || !move.pranksterBoosted || !pokemon.hasAbility('prankster')) {
			for (let i = 0; i < targets.length; i++) {
				hitResults[i] = true;
			}
			return hitResults;
		}
		for (let [i, target] of targets.entries()) {
			if (targets[i].side !== pokemon.side && !this.getImmunity('prankster', target)) {
				this.debug('natural prankster immunity');
				if (!target.illusion) this.add('-hint', "In gen 7, Dark is immune to Prankster moves.");
				this.add('-immune', target);
				hitResults[i] = false;
			} else {
				hitResults[i] = true;
			}
		}
		return hitResults;
	},
	accuracy(targets, pokemon, move) {
		let hitResults = [];
		for (let [i, target] of targets.entries()) {
			// calculate true accuracy
			/** @type {number | true} */ // TypeScript bug: incorrectly infers {number | true} as {number | boolean}
			let accuracy = move.accuracy;
			if (move.ohko) { // bypasses accuracy modifiers
				if (!target.isSemiInvulnerable()) {
					accuracy = 30;
					if (move.ohko === 'Ice' && this.gen >= 7 && !pokemon.hasType('Ice')) {
						accuracy = 20;
					}
					if (pokemon.level >= target.level && (move.ohko === true || !target.hasType(move.ohko))) {
						accuracy += (pokemon.level - target.level);
					} else {
						this.add('-immune', target, '[ohko]');
						hitResults[i] = false;
						continue;
					}
				}
			} else {
				let boostTable = [1, 4 / 3, 5 / 3, 2, 7 / 3, 8 / 3, 3];

				let boosts, boost;
				if (accuracy !== true) {
					if (!move.ignoreAccuracy) {
						boosts = this.runEvent('ModifyBoost', pokemon, null, null, Object.assign({}, pokemon.boosts));
						boost = this.clampIntRange(boosts['accuracy'], -6, 6);
						if (boost > 0) {
							accuracy *= boostTable[boost];
						} else {
							accuracy /= boostTable[-boost];
						}
					}
					if (!move.ignoreEvasion) {
						boosts = this.runEvent('ModifyBoost', target, null, null, Object.assign({}, target.boosts));
						boost = this.clampIntRange(boosts['evasion'], -6, 6);
						if (boost > 0) {
							accuracy /= boostTable[boost];
						} else if (boost < 0) {
							accuracy *= boostTable[-boost];
						}
					}
				}
				accuracy = this.runEvent('ModifyAccuracy', target, pokemon, move, accuracy);
			}
			if (move.alwaysHit || (move.id === 'toxic' && this.gen >= 6 && pokemon.hasType('Poison'))) {
				accuracy = true; // bypasses ohko accuracy modifiers
			} else {
				accuracy = this.runEvent('Accuracy', target, pokemon, move, accuracy);
			}
			if (accuracy !== true && !this.randomChance(accuracy, 100)) {
				if (!move.spreadHit) this.attrLastMove('[miss]');
				this.add('-miss', pokemon, target);
				hitResults[i] = false;
				continue;
			}
			hitResults[i] = true;
		}
		return hitResults;
	},
	breakProtect(targets, pokemon, move) {
		if (move.breaksProtect) {
			for (let target of targets) {
				let broke = false;
				for (const effectid of ['banefulbunker', 'kingsshield', 'protect', 'spikyshield']) {
					if (target.removeVolatile(effectid)) broke = true;
				}
				if (this.gen >= 6 || target.side !== pokemon.side) {
					for (const effectid of ['craftyshield', 'matblock', 'quickguard', 'wideguard']) {
						if (target.side.removeSideCondition(effectid)) broke = true;
					}
				}
				if (broke) {
					if (move.id === 'feint') {
						this.add('-activate', target, 'move: Feint');
					} else {
						this.add('-activate', target, 'move: ' + move.name, '[broken]');
					}
					if (this.gen >= 6) delete target.volatiles['stall'];
				}
			}
		}
		return undefined;
	},
	stealBoosts(targets, pokemon, move) {
		let target = targets[0]; // hardcoded
		if (move.stealsBoosts) {
			/** @type {{[k: string]: number}} */
			let boosts = {};
			let stolen = false;
			for (let statName in target.boosts) {
				// @ts-ignore
				let stage = target.boosts[statName];
				if (stage > 0) {
					boosts[statName] = stage;
					stolen = true;
				}
			}
			if (stolen) {
				this.attrLastMove('[still]');
				this.add('-clearpositiveboost', target, pokemon, 'move: ' + move.name);
				this.boost(boosts, pokemon, pokemon);

				for (let statName in boosts) {
					boosts[statName] = 0;
				}
				target.setBoost(boosts);
				this.addMove('-anim', pokemon, "Spectral Thief", target);
			}
		}
		return undefined;
	},
	afterMoveSecondaryEvent(targets, pokemon, move) {
		if (!move.negateSecondary && !(move.hasSheerForce && pokemon.hasAbility('sheerforce'))) {
			this.singleEvent('AfterMoveSecondary', move, null, targets[0], pokemon, move);
			this.runEvent('AfterMoveSecondary', targets, pokemon, move);
		}
		return undefined;
	},
	tryMoveHit(target, pokemon, move) {
		this.setActiveMove(move, pokemon, target);
		move.zBrokeProtect = false;

		let hitResult = this.singleEvent('PrepareHit', move, {}, target, pokemon, move);
		if (!hitResult) {
			if (hitResult === false) {
				this.add('-fail', pokemon);
				this.attrLastMove('[still]');
			}
			return false;
		}
		this.runEvent('PrepareHit', pokemon, target, move);

		if (!this.singleEvent('Try', move, null, pokemon, target, move)) {
			return false;
		}

		if (move.target === 'all' || move.target === 'foeSide' || move.target === 'allySide' || move.target === 'allyTeam') {
			if (move.target === 'all') {
				hitResult = this.runEvent('TryHitField', target, pokemon, move);
			} else {
				hitResult = this.runEvent('TryHitSide', target, pokemon, move);
			}
			if (!hitResult) {
				if (hitResult === false) {
					this.add('-fail', pokemon);
					this.attrLastMove('[still]');
				}
				return false;
			}
			return this.moveHit(target, pokemon, move);
		}

		hitResult = this.runEvent('TryImmunity', target, pokemon, move);
		if (!hitResult) {
			if (hitResult !== null) {
				if (!move.spreadHit) this.attrLastMove('[miss]');
				this.add('-miss', pokemon, target);
			}
			return false;
		}

		if (move.ignoreImmunity === undefined) {
			move.ignoreImmunity = (move.category === 'Status');
		}

		if (this.gen < 7 && (!move.ignoreImmunity || (move.ignoreImmunity !== true && !move.ignoreImmunity[move.type])) && !target.runImmunity(move.type, true)) {
			return false;
		}

		hitResult = this.runEvent('TryHit', target, pokemon, move);
		if (!hitResult) {
			if (hitResult === false) {
				this.add('-fail', pokemon);
				this.attrLastMove('[still]');
			} else if (hitResult === this.NOT_FAILURE) {
				return hitResult;
			}
			return false;
		}

		if (this.gen >= 7 && (!move.ignoreImmunity || (move.ignoreImmunity !== true && !move.ignoreImmunity[move.type])) && !target.runImmunity(move.type, true)) {
			return false;
		}
		if (move.flags['powder'] && target !== pokemon && !this.getImmunity('powder', target)) {
			this.debug('natural powder immunity');
			this.add('-immune', target);
			return false;
		}
		if (this.gen >= 7 && move.pranksterBoosted && pokemon.hasAbility('prankster') && target.side !== pokemon.side && !this.getImmunity('prankster', target)) {
			this.debug('natural prankster immunity');
			if (!target.illusion) this.add('-hint', "In gen 7, Dark is immune to Prankster moves.");
			this.add('-immune', target);
			return false;
		}

		let boostTable = [1, 4 / 3, 5 / 3, 2, 7 / 3, 8 / 3, 3];

		// calculate true accuracy
		/** @type {number | true} */ // TypeScript bug: incorrectly infers {number | true} as {number | boolean}
		let accuracy = move.accuracy;
		let boosts, boost;
		if (accuracy !== true) {
			if (!move.ignoreAccuracy) {
				boosts = this.runEvent('ModifyBoost', pokemon, null, null, Object.assign({}, pokemon.boosts));
				boost = this.clampIntRange(boosts['accuracy'], -6, 6);
				if (boost > 0) {
					accuracy *= boostTable[boost];
				} else {
					accuracy /= boostTable[-boost];
				}
			}
			if (!move.ignoreEvasion) {
				boosts = this.runEvent('ModifyBoost', target, null, null, Object.assign({}, target.boosts));
				boost = this.clampIntRange(boosts['evasion'], -6, 6);
				if (boost > 0) {
					accuracy /= boostTable[boost];
				} else if (boost < 0) {
					accuracy *= boostTable[-boost];
				}
			}
		}
		if (move.ohko) { // bypasses accuracy modifiers
			if (!target.isSemiInvulnerable()) {
				accuracy = 30;
				if (move.ohko === 'Ice' && this.gen >= 7 && !pokemon.hasType('Ice')) {
					accuracy = 20;
				}
				if (pokemon.level >= target.level && (move.ohko === true || !target.hasType(move.ohko))) {
					accuracy += (pokemon.level - target.level);
				} else {
					this.add('-immune', target, '[ohko]');
					return false;
				}
			}
		} else {
			accuracy = this.runEvent('ModifyAccuracy', target, pokemon, move, accuracy);
		}
		if (move.alwaysHit || (move.id === 'toxic' && this.gen >= 6 && pokemon.hasType('Poison'))) {
			accuracy = true; // bypasses ohko accuracy modifiers
		} else {
			accuracy = this.runEvent('Accuracy', target, pokemon, move, accuracy);
		}
		if (accuracy !== true && !this.randomChance(accuracy, 100)) {
			if (!move.spreadHit) this.attrLastMove('[miss]');
			this.add('-miss', pokemon, target);
			return false;
		}

		if (move.breaksProtect) {
			let broke = false;
			for (const effectid of ['banefulbunker', 'kingsshield', 'protect', 'spikyshield']) {
				if (target.removeVolatile(effectid)) broke = true;
			}
			if (this.gen >= 6 || target.side !== pokemon.side) {
				for (const effectid of ['craftyshield', 'matblock', 'quickguard', 'wideguard']) {
					if (target.side.removeSideCondition(effectid)) broke = true;
				}
			}
			if (broke) {
				if (move.id === 'feint') {
					this.add('-activate', target, 'move: Feint');
				} else {
					this.add('-activate', target, 'move: ' + move.name, '[broken]');
				}
				if (this.gen >= 6) delete target.volatiles['stall'];
			}
		}

		if (move.stealsBoosts) {
			/** @type {{[k: string]: number}} */
			let boosts = {};
			let stolen = false;
			for (let statName in target.boosts) {
				// @ts-ignore
				let stage = target.boosts[statName];
				if (stage > 0) {
					boosts[statName] = stage;
					stolen = true;
				}
			}
			if (stolen) {
				this.attrLastMove('[still]');
				this.add('-clearpositiveboost', target, pokemon, 'move: ' + move.name);
				this.boost(boosts, pokemon, pokemon);

				for (let statName in boosts) {
					boosts[statName] = 0;
				}
				target.setBoost(boosts);
				this.addMove('-anim', pokemon, "Spectral Thief", target);
			}
		}

		move.totalDamage = 0;
		/** @type {number | false | undefined} */
		let damage = 0;
		pokemon.lastDamage = 0;
		if (move.multihit) {
			let hits = move.multihit;
			if (Array.isArray(hits)) {
				// yes, it's hardcoded... meh
				if (hits[0] === 2 && hits[1] === 5) {
					if (this.gen >= 5) {
						hits = this.sample([2, 2, 3, 3, 4, 5]);
					} else {
						hits = this.sample([2, 2, 2, 3, 3, 3, 4, 5]);
					}
				} else {
					hits = this.random(hits[0], hits[1] + 1);
				}
			}
			hits = Math.floor(hits);
			let nullDamage = true;
			/** @type {number | false | undefined} */
			let moveDamage;
			// There is no need to recursively check the ´sleepUsable´ flag as Sleep Talk can only be used while asleep.
			let isSleepUsable = move.sleepUsable || this.getMove(move.sourceEffect).sleepUsable;
			let i;
			for (i = 0; i < hits && target.hp && pokemon.hp; i++) {
				if (pokemon.status === 'slp' && !isSleepUsable) break;
				move.hit = i + 1;

				if (move.multiaccuracy && i > 0) {
					accuracy = move.accuracy;
					if (accuracy !== true) {
						if (!move.ignoreAccuracy) {
							boosts = this.runEvent('ModifyBoost', pokemon, null, null, Object.assign({}, pokemon.boosts));
							boost = this.clampIntRange(boosts['accuracy'], -6, 6);
							if (boost > 0) {
								accuracy *= boostTable[boost];
							} else {
								accuracy /= boostTable[-boost];
							}
						}
						if (!move.ignoreEvasion) {
							boosts = this.runEvent('ModifyBoost', target, null, null, Object.assign({}, target.boosts));
							boost = this.clampIntRange(boosts['evasion'], -6, 6);
							if (boost > 0) {
								accuracy /= boostTable[boost];
							} else if (boost < 0) {
								accuracy *= boostTable[-boost];
							}
						}
					}
					accuracy = this.runEvent('ModifyAccuracy', target, pokemon, move, accuracy);
					if (!move.alwaysHit) {
						accuracy = this.runEvent('Accuracy', target, pokemon, move, accuracy);
						if (accuracy !== true && !this.randomChance(accuracy, 100)) break;
					}
				}

				moveDamage = this.moveHit(target, pokemon, move);
				if (moveDamage === false) break;
				if (nullDamage && (moveDamage || moveDamage === 0 || moveDamage === undefined)) nullDamage = false;
				// Damage from each hit is individually counted for the
				// purposes of Counter, Metal Burst, and Mirror Coat.
				damage = (moveDamage || 0);
				// Total damage dealt is accumulated for the purposes of recoil (Parental Bond).
				move.totalDamage += damage;
				if (move.mindBlownRecoil && i === 0) {
					this.damage(Math.round(pokemon.maxhp / 2), pokemon, pokemon, this.getEffect('Mind Blown'), true);
				}
				this.eachEvent('Update');
			}
			if (i === 0) return false;
			if (nullDamage) damage = false;
			this.add('-hitcount', target, i);
		} else {
			damage = this.moveHit(target, pokemon, move);
			move.totalDamage = damage;
		}

		if (move.recoil && move.totalDamage) {
			this.damage(this.calcRecoilDamage(move.totalDamage, move), pokemon, pokemon, 'recoil');
		}

		if (move.struggleRecoil) {
			// @ts-ignore
			this.directDamage(this.clampIntRange(Math.round(pokemon.maxhp / 4), 1), pokemon, pokemon, {id: 'strugglerecoil'});
		}

		if (target && pokemon !== target) target.gotAttacked(move, damage, pokemon);

		if (move.ohko) this.add('-ohko');

		if (!damage && damage !== 0) return damage;

		this.eachEvent('Update');

		if (target && !move.negateSecondary && !(move.hasSheerForce && pokemon.hasAbility('sheerforce'))) {
			this.singleEvent('AfterMoveSecondary', move, null, target, pokemon, move);
			this.runEvent('AfterMoveSecondary', target, pokemon, move);
		}

		return damage;
	},
	moveHitLoop(targets, pokemon, move) { // temp name
		/** @type {(number | boolean | undefined)[]} */
		let damage = [];
		for (let i = 0; i < targets.length; i++) damage[i] = 0;
		move.totalDamage = 0;
		pokemon.lastDamage = 0;
		let hits = move.multihit || 1;
		if (Array.isArray(hits)) {
			// yes, it's hardcoded... meh
			if (hits[0] === 2 && hits[1] === 5) {
				if (this.gen >= 5) {
					hits = this.sample([2, 2, 3, 3, 4, 5]);
				} else {
					hits = this.sample([2, 2, 2, 3, 3, 3, 4, 5]);
				}
			} else {
				hits = this.random(hits[0], hits[1] + 1);
			}
		}
		hits = Math.floor(hits);
		let nullDamage = true;
		/** @type {(number | boolean | undefined)[]} */
		let moveDamage;
		// There is no need to recursively check the ´sleepUsable´ flag as Sleep Talk can only be used while asleep.
		let isSleepUsable = move.sleepUsable || this.getMove(move.sourceEffect).sleepUsable;
		let i;
		/** @type {(Pokemon | false | null)[]} */
		let targetsCopy = targets.slice(0);
		for (i = 0; i < hits && !targetsCopy.includes(false) && pokemon.hp; i++) {
			if (pokemon.status === 'slp' && !isSleepUsable) break;
			move.hit = i + 1;

			let target = targetsCopy[0]; // some relevant-to-single-target-moves-only things are hardcoded

			// like this (Triple Kick)
			if (target && move.multiaccuracy && i > 0) {
				let accuracy = move.accuracy;
				let boostTable = [1, 4 / 3, 5 / 3, 2, 7 / 3, 8 / 3, 3];
				if (accuracy !== true) {
					if (!move.ignoreAccuracy) {
						let boosts = this.runEvent('ModifyBoost', pokemon, null, null, Object.assign({}, pokemon.boosts));
						let boost = this.clampIntRange(boosts['accuracy'], -6, 6);
						if (boost > 0) {
							accuracy *= boostTable[boost];
						} else {
							accuracy /= boostTable[-boost];
						}
					}
					if (!move.ignoreEvasion) {
						let boosts = this.runEvent('ModifyBoost', target, null, null, Object.assign({}, target.boosts));
						let boost = this.clampIntRange(boosts['evasion'], -6, 6);
						if (boost > 0) {
							accuracy /= boostTable[boost];
						} else if (boost < 0) {
							accuracy *= boostTable[-boost];
						}
					}
				}
				accuracy = this.runEvent('ModifyAccuracy', target, pokemon, move, accuracy);
				if (!move.alwaysHit) {
					accuracy = this.runEvent('Accuracy', target, pokemon, move, accuracy);
					if (accuracy !== true && !this.randomChance(accuracy, 100)) break;
				}
			}

			/** @type {?boolean | number} */
			let hitResult = true;
			let moveData = move;
			if (!moveData.flags) moveData.flags = {};
			// hardcoded for single-target moves
			if (target) {
				hitResult = this.singleEvent('TryHit', moveData, {}, target, pokemon, move);
			}
			if (!hitResult) {
				if (hitResult === false) {
					this.add('-fail', pokemon);
					this.attrLastMove('[still]');
				}
				break;
			}

			// Modifies targetsCopy (which is why it's a copy)
			moveDamage = this.spreadMoveHit(targetsCopy, pokemon, move, moveData);

			if (!moveDamage.some(val => val !== false)) {
				break;
			}
			nullDamage = false;

			for (let i = 0; i < targets.length; i++) {
				// Damage from each hit is individually counted for the
				// purposes of Counter, Metal Burst, and Mirror Coat.
				damage[i] = (moveDamage[i] || 0);
				// Total damage dealt is accumulated for the purposes of recoil (Parental Bond).
				// @ts-ignore
				move.totalDamage += damage[i];
			}
			if (move.mindBlownRecoil && i === 0) {
				this.damage(Math.round(pokemon.maxhp / 2), pokemon, pokemon, this.getEffect('Mind Blown'), true);
			}
			this.eachEvent('Update');
		}
		if (i === 0) return damage.fill(false);
		if (nullDamage) damage.fill(false);
		if (move.multihit) this.add('-hitcount', targets[0], i);

		if (move.recoil && move.totalDamage) {
			this.damage(this.calcRecoilDamage(move.totalDamage, move), pokemon, pokemon, 'recoil');
		}

		if (move.struggleRecoil) {
			// @ts-ignore
			this.directDamage(this.clampIntRange(Math.round(pokemon.maxhp / 4), 1), pokemon, pokemon, {id: 'strugglerecoil'});
		}

		for (let i = 0; i < targets.length; i++) {
			let target = targets[i];
			if (target && pokemon !== target) {
				// @ts-ignore damage[i] can't be true if target is truthy
				target.gotAttacked(move, damage[i], pokemon);
			}
		}

		if (move.ohko) this.add('-ohko');

		if (!damage.some(val => !!val || val === 0)) return damage;

		this.eachEvent('Update');

		return damage;
	},
	spreadMoveHit(targets, pokemon, moveOrMoveName, moveData, isSecondary, isSelf) {
		// Hardcoded for single-target purposes
		// (no spread moves have any kind of onTryHit handler)
		let target = targets[0];
		/** @type {(number | boolean | undefined)[]} */
		let damage = [];
		let move = this.getActiveMove(moveOrMoveName);
		/** @type {?boolean | number} */
		let hitResult = true;
		if (!moveData) moveData = move;
		if (!moveData.flags) moveData.flags = {};
		if (move.target === 'all' && !isSelf) {
			hitResult = this.singleEvent('TryHitField', moveData, {}, target || null, pokemon, move);
		} else if ((move.target === 'foeSide' || move.target === 'allySide') && !isSelf) {
			hitResult = this.singleEvent('TryHitSide', moveData, {}, (target ? target.side : null), pokemon, move);
		} else if (target) {
			hitResult = this.singleEvent('TryHit', moveData, {}, target, pokemon, move);
		}
		if (!hitResult) {
			if (hitResult === false) {
				this.add('-fail', pokemon);
				this.attrLastMove('[still]');
			}
			return [false]; // single-target only
		}

		// 0. check for substitute
		damage = this.tryPrimaryHitEvent(damage, targets, pokemon, move, moveData, isSecondary);

		for (let i = 0; i < targets.length; i++) {
			if (!damage[i]) targets[i] = false;
		}
		// 1. call to this.getDamage
		damage = this.getSpreadDamage(damage, targets, pokemon, move, moveData, isSecondary, isSelf);

		for (let i = 0; i < targets.length; i++) {
			if (damage[i] === false) targets[i] = false;
		}

		// 2. call to this.spreadDamage
		damage = this.spreadDamage(damage, targets, pokemon, move);

		for (let i = 0; i < targets.length; i++) {
			if (!damage && damage !== 0) {
				this.debug('damage interrupted');
				targets[i] = false;
			}
		}

		// 3. onHit event happens here
		damage = this.runMoveEffects(damage, targets, pokemon, move, moveData, isSecondary, isSelf);

		for (let i = 0; i < targets.length; i++) {
			if (!damage[i] && damage[i] !== 0) targets[i] = false;
		}

		// 4. self drops (start checking for targets[i] === false here)
		if (moveData.self && !move.selfDropped) this.selfDrops(targets, pokemon, move, moveData, isSecondary);

		// 5. secondary effects
		if (moveData.secondaries) this.secondaries(targets, pokemon, move, moveData, isSecondary);

		// 6. force switch
		if (moveData.forceSwitch) damage = this.forceSwitch(damage, targets, pokemon, move, moveData, isSecondary, isSelf);

		for (let j = 0; j < targets.length; j++) {
			if (!damage[j] && damage[j] !== 0) targets[j] = false;
		}

		return damage;
	},
	tryPrimaryHitEvent(damage, targets, pokemon, move, moveData, isSecondary) {
		damage = [];
		for (let i = 0; i < targets.length; i++) {
			const target = targets[i];
			if (!target) continue;
			damage[i] = this.runEvent('TryPrimaryHit', target, pokemon, moveData);
			if (damage[i] === 0) {
				// special Substitute flag
				damage[i] = true;
				targets[i] = null;
			}
			if (targets[i] && isSecondary && !moveData.self) {
				damage[i] = true;
			}
		}
		return damage;
	},
	getSpreadDamage(damage, targets, pokemon, move, moveData, isSecondary, isSelf) {
		damage.fill(undefined);
		for (let i = 0; i < targets.length; i++) {
			let target = targets[i];
			if (!target) continue;
			let curDamage = this.getDamage(pokemon, target, moveData);
			// getDamage has several possible return values:
			//
			//   a number:
			//     means that much damage is dealt (0 damage still counts as dealing
			//     damage for the purposes of things like Static)
			//   false:
			//     gives error message: "But it failed!" and move ends
			//   null:
			//     the move ends, with no message (usually, a custom fail message
			//     was already output by an event handler)
			//   undefined:
			//     means no damage is dealt and the move continues
			//
			// basically, these values have the same meanings as they do for event
			// handlers.

			if (curDamage === false || curDamage === null) {
				if (damage[i] === false && !isSecondary && !isSelf) {
					this.add('-fail', pokemon);
					this.attrLastMove('[still]');
				}
				this.debug('damage calculation interrupted');
				damage[i] = false;
				continue;
			}
			damage[i] = curDamage;
			if (move.selfdestruct === 'ifHit') {
				this.faint(pokemon, pokemon, move);
			}
			if ((damage[i] || damage[i] === 0) && !target.fainted) {
				// @ts-ignore
				if (move.noFaint && damage[i] >= target.hp) {
					damage[i] = target.hp - 1;
				}
			}
		}
		return damage;
	},
	runMoveEffects(damage, targets, pokemon, move, moveData, isSecondary, isSelf) {
		/**@type {?boolean | number | undefined} */
		let didAnything = damage.some(val => !!val || val === 0);
		for (let i = 0; i < targets.length; i++) {
			let target = targets[i];
			if (!target) continue;
			let hitResult;
			/**@type {?boolean | number | undefined} */
			let didSomething = damage.some(val => !!val || val === 0);
			if (moveData.boosts && !target.fainted) {
				hitResult = this.boost(moveData.boosts, target, pokemon, move, isSecondary, isSelf);
				didSomething = didSomething || hitResult;
			}
			if (moveData.heal && !target.fainted) {
				let d = target.heal((this.gen < 5 ? Math.floor : Math.round)(target.maxhp * moveData.heal[0] / moveData.heal[1]));
				if (!d && d !== 0) {
					this.add('-fail', pokemon);
					this.attrLastMove('[still]');
					this.debug('heal interrupted');
					continue;
				}
				this.add('-heal', target, target.getHealth);
				didSomething = true;
			}
			if (moveData.status) {
				hitResult = target.trySetStatus(moveData.status, pokemon, moveData.ability ? moveData.ability : move);
				if (!hitResult && move.status) {
					continue;
				}
				didSomething = didSomething || hitResult;
			}
			if (moveData.forceStatus) {
				hitResult = target.setStatus(moveData.forceStatus, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.volatileStatus) {
				hitResult = target.addVolatile(moveData.volatileStatus, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.sideCondition) {
				hitResult = target.side.addSideCondition(moveData.sideCondition, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.weather) {
				hitResult = this.setWeather(moveData.weather, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.terrain) {
				hitResult = this.setTerrain(moveData.terrain, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.pseudoWeather) {
				hitResult = this.addPseudoWeather(moveData.pseudoWeather, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.forceSwitch) {
				hitResult = !!this.canSwitch(target.side);
				didSomething = didSomething || hitResult;
			}
			if (moveData.selfSwitch) {
				// If the move is Parting Shot and it fails to change the target's stats in gen 7, didSomething will be null instead of undefined.
				// Leaving didSomething as null will cause this function to return before setting the switch flag, preventing the switch.
				if (this.canSwitch(pokemon.side) && (didSomething !== null || this.gen < 7)) {
					didSomething = true;
				} else {
					didSomething = didSomething || false;
				}
			}
			// Hit events
			//   These are like the TryHit events, except we don't need a FieldHit event.
			//   Scroll up for the TryHit event documentation, and just ignore the "Try" part. ;)
			if (move.target === 'all' && !isSelf) {
				if (moveData.onHitField) {
					hitResult = this.singleEvent('HitField', moveData, {}, target, pokemon, move);
					didSomething = didSomething || hitResult;
				}
			} else if ((move.target === 'foeSide' || move.target === 'allySide') && !isSelf) {
				if (moveData.onHitSide) {
					hitResult = this.singleEvent('HitSide', moveData, {}, target.side, pokemon, move);
					didSomething = didSomething || hitResult;
				}
			} else {
				if (moveData.onHit) {
					hitResult = this.singleEvent('Hit', moveData, {}, target, pokemon, move);
					didSomething = didSomething || hitResult;
				}
				if (!isSelf && !isSecondary) {
					this.runEvent('Hit', target, pokemon, move);
				}
				if (moveData.onAfterHit) {
					hitResult = this.singleEvent('AfterHit', moveData, {}, target, pokemon, move);
					didSomething = didSomething || hitResult;
				}
			}
			// Move didn't fail because it didn't try to do anything
			if (didSomething === undefined) didSomething = true;
			if (!didSomething && !moveData.self && !moveData.selfdestruct) {
				damage[i] = false;
			} else if (!damage[i] && damage[i] !== 0) {
				damage[i] = didSomething === null ? false : didSomething;
			}
			didAnything = didAnything || didAnything === null ? didAnything : didSomething;
		}


		if (!didAnything && !moveData.self && !moveData.selfdestruct) {
			if (!isSelf && !isSecondary) {
				if (didAnything === false) {
					this.add('-fail', pokemon);
					this.attrLastMove('[still]');
				}
			}
			this.debug('move failed because it did nothing');
		}

		return damage;
	},
	selfDrops(targets, pokemon, move, moveData, isSecondary) {
		for (let i = 0; i < targets.length; i++) {
			let target = targets[i];
			if (target === false) continue;
			if (moveData.self && !move.selfDropped) {
				let selfRoll = 0;
				if (!isSecondary && moveData.self.boosts) {
					selfRoll = this.random(100);
					if (!move.multihit) move.selfDropped = true;
				}
				// This is done solely to mimic in-game RNG behaviour. All self drops have a 100% chance of happening but still grab a random number.
				if (moveData.self.chance === undefined || selfRoll < moveData.self.chance) {
					this.moveHit(pokemon, pokemon, move, moveData.self, isSecondary, true);
				}
			}
		}
	},
	secondaries(targets, pokemon, move, moveData, isSelf) {
		if (!moveData.secondaries) return;
		for (const target of targets) {
			if (target === false) continue;
			/** @type {SecondaryEffect[]} */
			let secondaries = this.runEvent('ModifySecondaries', target, pokemon, moveData, moveData.secondaries.slice());
			for (const secondary of secondaries) {
				let secondaryRoll = this.random(100);
				if (typeof secondary.chance === 'undefined' || secondaryRoll < secondary.chance) {
					this.moveHit(target, pokemon, move, secondary, true, isSelf);
				}
			}
		}
	},
	forceSwitch(damage, targets, pokemon, move) {
		for (let i = 0; i < targets.length; i++) {
			let target = targets[i];
			if (target && target.hp > 0 && pokemon.hp > 0 && this.canSwitch(target.side)) {
				let hitResult = this.runEvent('DragOut', target, pokemon, move);
				if (hitResult) {
					target.forceSwitchFlag = true;
				} else if (hitResult === false && move.category === 'Status') {
					this.add('-fail', pokemon);
					this.attrLastMove('[still]');
					damage[i] = false;
				}
			}
		}
		return damage;
	},
	moveHit(target, pokemon, moveOrMoveName, moveData, isSecondary, isSelf) {
		/** @type {number | false | null | undefined} */
		let damage = undefined;
		let move = this.getActiveMove(moveOrMoveName);

		if (!moveData) moveData = move;
		if (!moveData.flags) moveData.flags = {};
		/** @type {?boolean | number} */
		let hitResult = true;

		// TryHit events:
		//   STEP 1: we see if the move will succeed at all:
		//   - TryHit, TryHitSide, or TryHitField are run on the move,
		//     depending on move target (these events happen in useMove
		//     or tryMoveHit, not below)
		//   == primary hit line ==
		//   Everything after this only happens on the primary hit (not on
		//   secondary or self-hits)
		//   STEP 2: we see if anything blocks the move from hitting:
		//   - TryFieldHit is run on the target
		//   STEP 3: we see if anything blocks the move from hitting the target:
		//   - If the move's target is a pokemon, TryHit is run on that pokemon

		// Note:
		//   If the move target is `foeSide`:
		//     event target = pokemon 0 on the target side
		//   If the move target is `allySide` or `all`:
		//     event target = the move user
		//
		//   This is because events can't accept actual sides or fields as
		//   targets. Choosing these event targets ensures that the correct
		//   side or field is hit.
		//
		//   It is the `TryHitField` event handler's responsibility to never
		//   use `target`.
		//   It is the `TryFieldHit` event handler's responsibility to read
		//   move.target and react accordingly.
		//   An exception is `TryHitSide` as a single event (but not as a normal
		//   event), which is passed the target side.

		if (move.target === 'all' && !isSelf) {
			hitResult = this.singleEvent('TryHitField', moveData, {}, target, pokemon, move);
		} else if ((move.target === 'foeSide' || move.target === 'allySide') && !isSelf) {
			hitResult = this.singleEvent('TryHitSide', moveData, {}, (target ? target.side : null), pokemon, move);
		} else if (target) {
			hitResult = this.singleEvent('TryHit', moveData, {}, target, pokemon, move);
		}
		if (!hitResult) {
			if (hitResult === false) {
				this.add('-fail', pokemon);
				this.attrLastMove('[still]');
			}
			return false;
		}

		if (target && !isSecondary && !isSelf) {
			if (move.target !== 'all' && move.target !== 'allySide' && move.target !== 'foeSide') {
				hitResult = this.runEvent('TryPrimaryHit', target, pokemon, moveData);
				if (hitResult === 0) {
					// special Substitute flag
					hitResult = true;
					target = null;
				}
			}
		}
		if (target && isSecondary && !moveData.self) {
			hitResult = true;
		}
		if (!hitResult) {
			return false;
		}

		if (target) {
			/**@type {?boolean | number | undefined} */
			let didSomething = undefined;

			damage = this.getDamage(pokemon, target, moveData);

			// getDamage has several possible return values:
			//
			//   a number:
			//     means that much damage is dealt (0 damage still counts as dealing
			//     damage for the purposes of things like Static)
			//   false:
			//     gives error message: "But it failed!" and move ends
			//   null:
			//     the move ends, with no message (usually, a custom fail message
			//     was already output by an event handler)
			//   undefined:
			//     means no damage is dealt and the move continues
			//
			// basically, these values have the same meanings as they do for event
			// handlers.

			if (damage === false || damage === null) {
				if (damage === false && !isSecondary && !isSelf) {
					this.add('-fail', pokemon);
					this.attrLastMove('[still]');
				}
				this.debug('damage calculation interrupted');
				return false;
			}
			if (move.selfdestruct === 'ifHit') {
				this.faint(pokemon, pokemon, move);
			}
			if ((damage || damage === 0) && !target.fainted) {
				if (move.noFaint && damage >= target.hp) {
					damage = target.hp - 1;
				}
				damage = this.damage(damage, target, pokemon, move);
				if (!(damage || damage === 0)) {
					this.debug('damage interrupted');
					return false;
				}
				didSomething = true;
			}

			if (moveData.boosts && !target.fainted) {
				hitResult = this.boost(moveData.boosts, target, pokemon, move, isSecondary, isSelf);
				didSomething = didSomething || hitResult;
			}
			if (moveData.heal && !target.fainted) {
				let d = target.heal((this.gen < 5 ? Math.floor : Math.round)(target.maxhp * moveData.heal[0] / moveData.heal[1]));
				if (!d && d !== 0) {
					this.add('-fail', pokemon);
					this.attrLastMove('[still]');
					this.debug('heal interrupted');
					return false;
				}
				this.add('-heal', target, target.getHealth);
				didSomething = true;
			}
			if (moveData.status) {
				hitResult = target.trySetStatus(moveData.status, pokemon, moveData.ability ? moveData.ability : move);
				if (!hitResult && move.status) return false;
				didSomething = didSomething || hitResult;
			}
			if (moveData.forceStatus) {
				hitResult = target.setStatus(moveData.forceStatus, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.volatileStatus) {
				hitResult = target.addVolatile(moveData.volatileStatus, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.sideCondition) {
				hitResult = target.side.addSideCondition(moveData.sideCondition, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.weather) {
				hitResult = this.setWeather(moveData.weather, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.terrain) {
				hitResult = this.setTerrain(moveData.terrain, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.pseudoWeather) {
				hitResult = this.addPseudoWeather(moveData.pseudoWeather, pokemon, move);
				didSomething = didSomething || hitResult;
			}
			if (moveData.forceSwitch) {
				hitResult = !!this.canSwitch(target.side);
				didSomething = didSomething || hitResult;
			}
			if (moveData.selfSwitch) {
				// If the move is Parting Shot and it fails to change the target's stats in gen 7, didSomething will be null instead of undefined.
				// Leaving didSomething as null will cause this function to return before setting the switch flag, preventing the switch.
				if (this.canSwitch(pokemon.side) && (didSomething !== null || this.gen < 7)) {
					didSomething = true;
				} else {
					didSomething = didSomething || false;
				}
			}
			// Hit events
			//   These are like the TryHit events, except we don't need a FieldHit event.
			//   Scroll up for the TryHit event documentation, and just ignore the "Try" part. ;)
			if (move.target === 'all' && !isSelf) {
				if (moveData.onHitField) {
					hitResult = this.singleEvent('HitField', moveData, {}, target, pokemon, move);
					didSomething = didSomething || hitResult;
				}
			} else if ((move.target === 'foeSide' || move.target === 'allySide') && !isSelf) {
				if (moveData.onHitSide) {
					hitResult = this.singleEvent('HitSide', moveData, {}, target.side, pokemon, move);
					didSomething = didSomething || hitResult;
				}
			} else {
				if (moveData.onHit) {
					hitResult = this.singleEvent('Hit', moveData, {}, target, pokemon, move);
					didSomething = didSomething || hitResult;
				}
				if (!isSelf && !isSecondary) {
					this.runEvent('Hit', target, pokemon, move);
				}
				if (moveData.onAfterHit) {
					hitResult = this.singleEvent('AfterHit', moveData, {}, target, pokemon, move);
					didSomething = didSomething || hitResult;
				}
			}

			// Move didn't fail because it didn't try to do anything
			if (didSomething === undefined) didSomething = true;

			if (!didSomething && !moveData.self && !moveData.selfdestruct) {
				if (!isSelf && !isSecondary) {
					if (didSomething === false) {
						this.add('-fail', pokemon);
						this.attrLastMove('[still]');
					}
				}
				this.debug('move failed because it did nothing');
				return false;
			}
		}
		if (moveData.self && !move.selfDropped) {
			let selfRoll = 0;
			if (!isSecondary && moveData.self.boosts) {
				selfRoll = this.random(100);
				if (!move.multihit) move.selfDropped = true;
			}
			// This is done solely to mimic in-game RNG behaviour. All self drops have a 100% chance of happening but still grab a random number.
			if (moveData.self.chance === undefined || selfRoll < moveData.self.chance) {
				this.moveHit(pokemon, pokemon, move, moveData.self, isSecondary, true);
			}
		}
		if (moveData.secondaries) {
			/** @type {SecondaryEffect[]} */
			let secondaries = this.runEvent('ModifySecondaries', target, pokemon, moveData, moveData.secondaries.slice());
			for (const secondary of secondaries) {
				let secondaryRoll = this.random(100);
				if (typeof secondary.chance === 'undefined' || secondaryRoll < secondary.chance) {
					this.moveHit(target, pokemon, move, secondary, true, isSelf);
				}
			}
		}
		if (target && target.hp > 0 && pokemon.hp > 0 && moveData.forceSwitch && this.canSwitch(target.side)) {
			hitResult = this.runEvent('DragOut', target, pokemon, move);
			if (hitResult) {
				target.forceSwitchFlag = true;
			} else if (hitResult === false && move.category === 'Status') {
				this.add('-fail', pokemon);
				this.attrLastMove('[still]');
				return false;
			}
		}
		if (move.selfSwitch && pokemon.hp) {
			pokemon.switchFlag = move.fullname;
		}
		return damage;
	},

	calcRecoilDamage(damageDealt, move) {
		// @ts-ignore
		return this.clampIntRange(Math.round(damageDealt * move.recoil[0] / move.recoil[1]), 1);
	},

	zMoveTable: {
		Poison: "Acid Downpour",
		Fighting: "All-Out Pummeling",
		Dark: "Black Hole Eclipse",
		Grass: "Bloom Doom",
		Normal: "Breakneck Blitz",
		Rock: "Continental Crush",
		Steel: "Corkscrew Crash",
		Dragon: "Devastating Drake",
		Electric: "Gigavolt Havoc",
		Water: "Hydro Vortex",
		Fire: "Inferno Overdrive",
		Ghost: "Never-Ending Nightmare",
		Bug: "Savage Spin-Out",
		Psychic: "Shattered Psyche",
		Ice: "Subzero Slammer",
		Flying: "Supersonic Skystrike",
		Ground: "Tectonic Rage",
		Fairy: "Twinkle Tackle",
	},

	getZMove(move, pokemon, skipChecks) {
		let item = pokemon.getItem();
		if (!skipChecks) {
			if (pokemon.side.zMoveUsed) return;
			if (!item.zMove) return;
			if (item.zMoveUser && !item.zMoveUser.includes(pokemon.template.species)) return;
			let moveData = pokemon.getMoveData(move);
			if (!moveData || !moveData.pp) return; // Draining the PP of the base move prevents the corresponding Z-move from being used.
		}

		if (item.zMoveFrom) {
			if (move.name === item.zMoveFrom) return /** @type {string} */ (item.zMove);
		} else if (item.zMove === true) {
			if (move.type === item.zMoveType) {
				if (move.category === "Status") {
					return move.name;
				} else if (move.zMovePower) {
					return this.zMoveTable[move.type];
				}
			}
		}
	},

	getActiveZMove(move, pokemon) {
		if (pokemon) {
			let item = pokemon.getItem();
			if (move.name === item.zMoveFrom) {
				// @ts-ignore
				let zMove = this.getActiveMove(item.zMove);
				zMove.isZPowered = true;
				return zMove;
			}
		}

		if (move.category === 'Status') {
			let zMove = this.getActiveMove(move);
			zMove.isZ = true;
			zMove.isZPowered = true;
			return zMove;
		}
		let zMove = this.getActiveMove(this.zMoveTable[move.type]);
		// @ts-ignore
		zMove.basePower = move.zMovePower;
		zMove.category = move.category;
		// copy the priority for Quick Guard
		zMove.priority = move.priority;
		zMove.isZPowered = true;
		return zMove;
	},

	canZMove(pokemon) {
		if (pokemon.side.zMoveUsed || (pokemon.transformed && (pokemon.template.isMega || pokemon.template.isPrimal || pokemon.template.forme === "Ultra"))) return;
		let item = pokemon.getItem();
		if (!item.zMove) return;
		if (item.zMoveUser && !item.zMoveUser.includes(pokemon.template.species)) return;
		let atLeastOne = false;
		/**@type {AnyObject?[]} */
		let zMoves = [];
		for (const moveSlot of pokemon.moveSlots) {
			if (moveSlot.pp <= 0) {
				zMoves.push(null);
				continue;
			}
			let move = this.getMove(moveSlot.move);
			let zMoveName = this.getZMove(move, pokemon, true) || '';
			if (zMoveName) {
				let zMove = this.getMove(zMoveName);
				if (!zMove.isZ && zMove.category === 'Status') zMoveName = "Z-" + zMoveName;
				zMoves.push({move: zMoveName, target: zMove.target});
			} else {
				zMoves.push(null);
			}
			if (zMoveName) atLeastOne = true;
		}
		if (atLeastOne) return zMoves;
	},

	canMegaEvo(pokemon) {
		let altForme = pokemon.baseTemplate.otherFormes && this.getTemplate(pokemon.baseTemplate.otherFormes[0]);
		let item = pokemon.getItem();
		if (altForme && altForme.isMega && altForme.requiredMove && pokemon.baseMoves.includes(toId(altForme.requiredMove)) && !item.zMove) return altForme.species;
		if (item.megaEvolves !== pokemon.baseTemplate.baseSpecies || item.megaStone === pokemon.species) {
			return null;
		}
		return item.megaStone;
	},

	canUltraBurst(pokemon) {
		if (['Necrozma-Dawn-Wings', 'Necrozma-Dusk-Mane'].includes(pokemon.baseTemplate.species) &&
			pokemon.getItem().id === 'ultranecroziumz') {
			return "Necrozma-Ultra";
		}
		return null;
	},

	runMegaEvo(pokemon) {
		const templateid = pokemon.canMegaEvo || pokemon.canUltraBurst;
		if (!templateid) return false;
		const side = pokemon.side;

		// Pokémon affected by Sky Drop cannot mega evolve. Enforce it here for now.
		for (const foeActive of side.foe.active) {
			if (foeActive.volatiles['skydrop'] && foeActive.volatiles['skydrop'].source === pokemon) {
				return false;
			}
		}

		pokemon.formeChange(templateid, pokemon.getItem(), true);

		// Limit one mega evolution
		let wasMega = pokemon.canMegaEvo;
		for (const ally of side.pokemon) {
			if (wasMega) {
				ally.canMegaEvo = null;
			} else {
				ally.canUltraBurst = null;
			}
		}

		this.runEvent('AfterMega', pokemon);
		return true;
	},

	runZPower(move, pokemon) {
		const zPower = this.getEffect('zpower');
		if (move.category !== 'Status') {
			this.attrLastMove('[zeffect]');
		} else if (move.zMoveBoost) {
			this.boost(move.zMoveBoost, pokemon, pokemon, zPower);
		} else {
			switch (move.zMoveEffect) {
			case 'heal':
				this.heal(pokemon.maxhp, pokemon, pokemon, zPower);
				break;
			case 'healreplacement':
				move.self = {sideCondition: 'healreplacement'};
				break;
			case 'clearnegativeboost':
				/** @type {{[k: string]: number}} */
				let boosts = {};
				for (let i in pokemon.boosts) {
					// @ts-ignore
					if (pokemon.boosts[i] < 0) {
						boosts[i] = 0;
					}
				}
				pokemon.setBoost(boosts);
				this.add('-clearnegativeboost', pokemon, '[zeffect]');
				break;
			case 'redirect':
				pokemon.addVolatile('followme', pokemon, zPower);
				break;
			case 'crit2':
				pokemon.addVolatile('focusenergy', pokemon, zPower);
				break;
			case 'curse':
				if (pokemon.hasType('Ghost')) {
					this.heal(pokemon.maxhp, pokemon, pokemon, zPower);
				} else {
					this.boost({atk: 1}, pokemon, pokemon, zPower);
				}
			}
		}
	},

	isAdjacent(pokemon1, pokemon2) {
		if (pokemon1.fainted || pokemon2.fainted) return false;
		if (pokemon1.side === pokemon2.side) return Math.abs(pokemon1.position - pokemon2.position) === 1;
		return Math.abs(pokemon1.position + pokemon2.position + 1 - pokemon1.side.active.length) <= 1;
	},

	targetTypeChoices(targetType) {
		return CHOOSABLE_TARGETS.has(targetType);
	},
};

exports.BattleScripts = BattleScripts;
