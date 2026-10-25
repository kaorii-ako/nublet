const SUBSTEP = 1 / 240;
const MAX_DT = 0.05;

export function springParams(response, dampingRatio) {
    const omega = 2 * Math.PI / response;
    return {stiffness: omega * omega, damping: 2 * dampingRatio * omega};
}

export class Spring {
    constructor(value, precision = 0.1) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.precision = precision;
    }

    step(dt, {stiffness, damping}) {
        for (let left = Math.min(dt, MAX_DT); left > 0; left -= SUBSTEP) {
            const h = Math.min(SUBSTEP, left);
            this.velocity += (stiffness * (this.target - this.value) - damping * this.velocity) * h;
            this.value += this.velocity * h;
        }
    }

    get settled() {
        return Math.abs(this.target - this.value) < this.precision &&
            Math.abs(this.velocity) < this.precision * 10;
    }

    snap() {
        this.value = this.target;
        this.velocity = 0;
    }
}
