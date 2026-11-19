let day = 0;

export const nextTestDay = () => new Date(Date.UTC(2100, 0, ++day));
