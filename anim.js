import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';

const EASE_OUT = [new Graphene.Point({x: 0.23, y: 1}), new Graphene.Point({x: 0.32, y: 1})];
const NOT_PROPERTIES = new Set(['duration', 'delay', 'mode', 'onComplete', 'onStopped', 'repeatCount', 'autoReverse', 'animationRequired']);

export function easeOut(actor, params) {
    actor.ease({mode: Clutter.AnimationMode.EASE_OUT_CUBIC, ...params});
    for (const key of Object.keys(params)) {
        if (!NOT_PROPERTIES.has(key))
            actor.get_transition(key.replaceAll('_', '-'))?.set_cubic_bezier_progress(...EASE_OUT);
    }
}

export function easeOutProperty(actor, property, value, params) {
    actor.ease_property(property, value, {mode: Clutter.AnimationMode.EASE_OUT_CUBIC, ...params});
    actor.get_transition(property)?.set_cubic_bezier_progress(...EASE_OUT);
}
